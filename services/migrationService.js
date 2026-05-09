'use strict';
const { v4: uuidv4 }   = require('uuid');
const { Parser }       = require('json2csv');
const fs               = require('fs');
const path             = require('path');

const db               = require('../database/database');
const logger           = require('../utils/logger');
const {
  sleep, withRetry, RateLimitQueue,
  validateBotPermissions, validateRole,
  chunkArray,
} = require('../utils/helpers');
const { migrationReportEmbed, progressEmbed, errorEmbed } = require('../utils/embeds');
const config           = require('../config/config');

// ── Active job registry ─────────────────────────────────────────────────────
// Maps guildId → { jobId, cancelRequested, queue, progressMessage }

const activeJobs = new Map();

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Starts a role migration job.
 *
 * @param {object} opts
 * @param {Guild}         opts.guild
 * @param {GuildMember}   opts.initiatorMember
 * @param {Role}          opts.sourceRole
 * @param {Role}          opts.targetRole
 * @param {boolean}       opts.removeOldRole
 * @param {boolean}       opts.includeBots
 * @param {boolean}       opts.dryRun
 * @param {TextChannel?}  opts.logChannel
 * @param {Message?}      opts.progressMessage  – editable progress message
 * @returns {Promise<string>} jobId
 */
async function startMigration(opts) {
  const {
    guild, initiatorMember, sourceRole, targetRole,
    removeOldRole, includeBots, dryRun, logChannel, progressMessage,
  } = opts;

  const guildId = guild.id;

  // ── Guard: no concurrent jobs per guild ──────────────────────────────────
  if (activeJobs.has(guildId)) {
    throw new Error('A migration is already running in this server. Use `/cancel-migration` to stop it first.');
  }

  // ── Fetch all guild members (skip if cache is already complete) ─────────
  logger.info(`[Migration] Fetching members for guild "${guild.name}" (${guildId})…`);
  const cacheComplete = guild.members.cache.size >= guild.memberCount;
  if (!cacheComplete) {
    try {
      await guild.members.fetch();
    } catch (err) {
      logger.warn(`[Migration] Member fetch rate-limited, using cached members: ${err.message}`);
    }
  }

  // ── Pre-filter: only members who actually have the SOURCE role ────────────
  // This ensures "Eligible Members" reflects the real migration target count
  // (e.g. 150, not 5,423 total guild members) and avoids iterating everyone.
  const eligible = [...guild.members.cache.values()].filter(m => {
    if (!includeBots && m.user.bot) return false;       // skip bots unless opted in
    if (!m.roles.cache.has(sourceRole.id)) return false; // must have source role
    return true;
  });

  // ── Create job record ────────────────────────────────────────────────────
  const jobId = uuidv4();
  const now   = Date.now();

  const logChannelId = logChannel?.id || db.getConfig(guildId, 'logChannelId', config.channels.logChannelId) || null;

  db.createJob({
    id:               jobId,
    guild_id:         guildId,
    guild_name:       guild.name,
    source_role_id:   sourceRole.id,
    source_role_name: sourceRole.name,
    target_role_id:   targetRole.id,
    target_role_name: targetRole.name,
    initiator_id:     initiatorMember.id,
    initiator_tag:    initiatorMember.user.tag,
    remove_old_role:  removeOldRole ? 1 : 0,
    include_bots:     includeBots   ? 1 : 0,
    dry_run:          dryRun        ? 1 : 0,
    status:           'running',
    total_members:    eligible.length,
    started_at:       now,
    log_channel_id:   logChannelId,
  });

  // ── Register as active ───────────────────────────────────────────────────
  const jobState = {
    jobId,
    cancelRequested: false,
    queue: new RateLimitQueue(config.rateLimiting.delayMs),
    progressMessage,
    logChannel: null, // resolved below
  };
  activeJobs.set(guildId, jobState);

  // ── Resolve log channel ──────────────────────────────────────────────────
  if (logChannelId) {
    try {
      jobState.logChannel = await guild.channels.fetch(logChannelId);
    } catch {
      logger.warn(`[Migration] Could not resolve log channel ${logChannelId}; continuing without it.`);
    }
  }

  // ── Post "started" notice to log channel ─────────────────────────────────
  if (jobState.logChannel) {
    await safeChannelSend(jobState.logChannel, {
      embeds: [buildStartEmbed({ jobId, guild, initiatorMember, sourceRole, targetRole, eligible, removeOldRole, includeBots, dryRun })],
    });
  }

  logger.info(`[Migration][${jobId}] Starting — ${eligible.length} eligible members | source: ${sourceRole.name} | target: ${targetRole.name} | dryRun: ${dryRun}`);

  // ── Run migration asynchronously ─────────────────────────────────────────
  // We do NOT await this — the command interaction can reply immediately.
  _runMigration({ jobId, guildId, guild, eligible, sourceRole, targetRole, removeOldRole, dryRun, jobState }).catch(err => {
    logger.error(`[Migration][${jobId}] Unhandled error in migration runner.`, { error: err.message });
  });

  return jobId;
}

/**
 * Returns the live status of an active or recently completed job.
 * @param {string} guildId
 * @returns {{ active: boolean, job: object|null, state: object|null }}
 */
function getMigrationStatus(guildId) {
  const state   = activeJobs.get(guildId) || null;
  const jobId   = state?.jobId || null;
  const job     = jobId ? db.getJob(jobId) : db.getActiveJob(guildId);
  return { active: !!state, job, state };
}

/**
 * Requests cancellation of the active job for the given guild.
 * @param {string} guildId
 * @returns {string|null} jobId that was cancelled, or null if nothing was running
 */
function cancelMigration(guildId) {
  const state = activeJobs.get(guildId);
  if (!state) return null;

  logger.info(`[Migration][${state.jobId}] Cancel requested.`);
  state.cancelRequested = true;
  state.queue.cancelAll('Migration cancelled by administrator');
  return state.jobId;
}

/**
 * Exports migration results to JSON and CSV files in the ./exports directory.
 * @param {string} jobId
 * @returns {{ jsonPath: string, csvPath: string }}
 */
function exportMigrationResults(jobId) {
  const job     = db.getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} not found.`);

  const members = db.getMemberLogs(jobId);

  const exportDir = path.resolve('./exports');
  fs.mkdirSync(exportDir, { recursive: true });

  const base     = `migration_${jobId}`;
  const jsonPath = path.join(exportDir, `${base}.json`);
  const csvPath  = path.join(exportDir, `${base}.csv`);

  // JSON export
  fs.writeFileSync(jsonPath, JSON.stringify({ job, members }, null, 2), 'utf8');

  // CSV export
  const parser = new Parser({
    fields: ['id', 'job_id', 'member_id', 'username', 'result', 'reason', 'processed_at'],
  });
  fs.writeFileSync(csvPath, parser.parse(members), 'utf8');

  logger.info(`[Export][${jobId}] Exported to ${jsonPath} and ${csvPath}`);
  return { jsonPath, csvPath };
}

// ── Internal migration runner ───────────────────────────────────────────────

/**
 * Core migration loop. Processes members in batches, applying rate-limited
 * role assignments with retry logic. Posts progress updates periodically.
 *
 * @param {object} params
 */
async function _runMigration({
  jobId, guildId, guild, eligible,
  sourceRole, targetRole, removeOldRole, dryRun, jobState,
}) {
  let migrated = 0;
  let failed   = 0;
  let skipped  = 0;
  let checked  = 0;

  const startTime = db.getJob(jobId)?.started_at || Date.now();
  const batches   = chunkArray(eligible, config.rateLimiting.batchSize);

  // ── Progress update interval ─────────────────────────────────────────────
  const PROGRESS_INTERVAL_MS = 10_000; // update every 10 s
  let lastProgressUpdate = Date.now();

  const updateProgress = async () => {
    const stats = { total: eligible.length, checked, migrated, failed, skipped, startTime, jobId, dryRun };
    if (jobState.progressMessage) {
      try {
        await jobState.progressMessage.edit({ embeds: [progressEmbed(stats)] });
      } catch { /* message may have been deleted */ }
    }
    if (jobState.logChannel) {
      // Post a progress update to the log channel every minute
      if (Date.now() - lastProgressUpdate >= 60_000) {
        await safeChannelSend(jobState.logChannel, { embeds: [progressEmbed(stats)] });
        lastProgressUpdate = Date.now();
      }
    }
  };

  // ── Batch processing ─────────────────────────────────────────────────────
  outer:
  for (const batch of batches) {
    for (const member of batch) {
      // Check for cancellation
      if (jobState.cancelRequested) {
        logger.info(`[Migration][${jobId}] Cancelled at ${checked}/${eligible.length} members.`);
        break outer;
      }

      checked++;

      // Does the member have the source role?
      // (This should never trigger now since we pre-filter, but kept as a safety net)
      if (!member.roles.cache.has(sourceRole.id)) {
        skipped++;
        logger.info(`[Migration][${jobId}] [${checked}/${eligible.length}] ⏭️  SKIP  ${member.displayName} (${member.user.tag}) — no source role`);
        db.logMemberResult({ job_id: jobId, member_id: member.id, username: member.user.tag, result: 'skipped', reason: 'No source role' });
        db.incrementJobStats(jobId, { checked: 1, skipped: 1 });
        continue;
      }

      // Does the member already have the target role?
      if (member.roles.cache.has(targetRole.id)) {
        skipped++;
        logger.info(`[Migration][${jobId}] [${checked}/${eligible.length}] ⏭️  SKIP  ${member.displayName} (${member.user.tag}) — already has ${targetRole.name}`);
        db.logMemberResult({ job_id: jobId, member_id: member.id, username: member.user.tag, result: 'skipped', reason: 'Already has target role' });
        db.incrementJobStats(jobId, { checked: 1, skipped: 1 });
        continue;
      }

      // ── Apply role changes ──────────────────────────────────────────────
      if (dryRun) {
        // Dry-run: log what WOULD have happened, but make no API calls
        migrated++;
        logger.info(`[Migration][${jobId}] [${checked}/${eligible.length}] 🧪  DRY   ${member.displayName} (${member.user.tag}) — would assign ${targetRole.name}`);
        db.logMemberResult({ job_id: jobId, member_id: member.id, username: member.user.tag, result: 'dry_run', reason: null });
        db.incrementJobStats(jobId, { checked: 1, migrated: 1 });
      } else {
        // Live: assign target role (and optionally remove source role)
        const success = await jobState.queue.enqueue(() =>
          _applyRoleChange({ member, sourceRole, targetRole, removeOldRole, jobId })
        ).then(() => true).catch(err => {
          logger.error(`[Migration][${jobId}] [${checked}/${eligible.length}] ❌  FAIL  ${member.displayName} (${member.user.tag}) — ${err.message}`);
          db.logMemberResult({ job_id: jobId, member_id: member.id, username: member.user.tag, result: 'failed', reason: err.message });
          db.incrementJobStats(jobId, { checked: 1, failed: 1 });
          return false;
        });

        if (success) {
          migrated++;
          const removeNote = removeOldRole ? ` (removed ${sourceRole.name})` : '';
          logger.info(`[Migration][${jobId}] [${checked}/${eligible.length}] ✅  DONE  ${member.displayName} (${member.user.tag}) → ${targetRole.name}${removeNote}`);
          db.logMemberResult({ job_id: jobId, member_id: member.id, username: member.user.tag, result: 'migrated', reason: null });
          db.incrementJobStats(jobId, { checked: 1, migrated: 1 });
        } else {
          failed++;
        }
      }

      // ── Periodic progress update ──────────────────────────────────────
      if (Date.now() - lastProgressUpdate >= PROGRESS_INTERVAL_MS) {
        await updateProgress();
        lastProgressUpdate = Date.now();
      }
    }

    // Small yield between batches to prevent event-loop starvation
    await sleep(50);
  }

  // ── Finalize ─────────────────────────────────────────────────────────────
  const endTime     = Date.now();
  const wasCancelled = jobState.cancelRequested;

  db.updateJobStatus(jobId, wasCancelled ? 'cancelled' : 'completed', {
    completed_at: endTime,
    ...(wasCancelled ? { cancelled_at: endTime } : {}),
  });

  activeJobs.delete(guildId);

  logger.info(
    `[Migration][${jobId}] ${wasCancelled ? 'CANCELLED' : 'COMPLETED'} — ` +
    `checked=${checked} migrated=${migrated} failed=${failed} skipped=${skipped}`
  );

  // ── Final report ──────────────────────────────────────────────────────────
  const finalJob = db.getJob(jobId);
  if (jobState.logChannel && finalJob) {
    const report = {
      jobId,
      guildName:     guild.name,
      sourceRole:    { id: sourceRole.id,   name: sourceRole.name },
      targetRole:    { id: targetRole.id,   name: targetRole.name },
      initiator:     `<@${finalJob.initiator_id}> (${finalJob.initiator_tag})`,
      startTime:     finalJob.started_at,
      endTime:       finalJob.completed_at,
      total:         finalJob.total_members,
      migrated:      finalJob.migrated,
      failed:        finalJob.failed,
      skipped:       finalJob.skipped,
      removeOldRole: !!finalJob.remove_old_role,
      includeBots:   !!finalJob.include_bots,
      dryRun:        !!finalJob.dry_run,
      cancelledAt:   finalJob.cancelled_at,
    };
    await safeChannelSend(jobState.logChannel, { embeds: [migrationReportEmbed(report)] });
  }

  // ── Final progress message edit ───────────────────────────────────────────
  if (jobState.progressMessage) {
    const finalStats = { total: eligible.length, checked, migrated, failed, skipped, startTime, jobId, dryRun };
    await jobState.progressMessage.edit({ embeds: [progressEmbed({ ...finalStats, done: true })] }).catch(() => {});
  }
}

/**
 * Applies role assignment (and optional removal) for a single member with retry.
 * @param {object} params
 */
async function _applyRoleChange({ member, sourceRole, targetRole, removeOldRole, jobId }) {
  await withRetry(
    async () => {
      // Add target role
      await member.roles.add(targetRole, `Role migration job ${jobId}`);

      // Optionally remove source role
      if (removeOldRole) {
        await member.roles.remove(sourceRole, `Role migration job ${jobId}`);
      }
    },
    config.rateLimiting.maxRetries,
    1000,
    `role change for ${member.user.tag}`
  );
}

// ── Embed helpers ─────────────────────────────────────────────────────────

function buildStartEmbed({ jobId, guild, initiatorMember, sourceRole, targetRole, eligible, removeOldRole, includeBots, dryRun }) {
  const { EmbedBuilder } = require('discord.js');
  const { PALETTE }      = require('../utils/embeds');

  return new EmbedBuilder()
    .setColor(PALETTE.INFO)
    .setTitle(`🚀  Migration Started${dryRun ? ' (Dry Run)' : ''}`)
    .setDescription(`**Server:** ${guild.name}\n**Job ID:** \`${jobId}\``)
    .addFields(
      { name: '👤 Administrator', value: `<@${initiatorMember.id}> (${initiatorMember.user.tag})`, inline: false },
      { name: '🏷️ Source Role',  value: `<@&${sourceRole.id}> \`${sourceRole.name}\``, inline: true },
      { name: '🎯 Target Role',  value: `<@&${targetRole.id}> \`${targetRole.name}\``, inline: true },
      { name: '\u200B', value: '\u200B', inline: true },
      { name: '👥 Eligible Members', value: `\`${eligible.length.toLocaleString()}\``, inline: true },
      { name: '🗑️ Remove Old Role',  value: removeOldRole ? 'Yes' : 'No', inline: true },
      { name: '🤖 Include Bots',     value: includeBots   ? 'Yes' : 'No', inline: true },
    )
    .setTimestamp()
    .setFooter({ text: 'Discord Role Migration Bot' });
}

// ── Utility ───────────────────────────────────────────────────────────────

/**
 * Sends a message to a channel, catching and logging errors silently.
 * @param {TextChannel} channel
 * @param {object}      payload
 */
async function safeChannelSend(channel, payload) {
  try {
    return await channel.send(payload);
  } catch (err) {
    logger.warn(`[Migration] Failed to send to log channel: ${err.message}`);
    return null;
  }
}

module.exports = {
  startMigration,
  getMigrationStatus,
  cancelMigration,
  exportMigrationResults,
  activeJobs,
};
