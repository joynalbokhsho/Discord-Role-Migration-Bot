'use strict';
const { Colors, EmbedBuilder } = require('discord.js');

// ── Colour palette ──────────────────────────────────────────────────────────

const PALETTE = {
  PRIMARY:  0x5865F2, // Discord blurple
  SUCCESS:  0x57F287, // Green
  WARNING:  0xFEE75C, // Yellow
  DANGER:   0xED4245, // Red
  INFO:     0x5865F2, // Info blue
  NEUTRAL:  0x36393F, // Dark neutral
  ORANGE:   0xE67E22, // Progress orange
};

// ── Shared footer ───────────────────────────────────────────────────────────

function setCommonFooter(embed) {
  return embed.setFooter({
    text: 'Discord Role Migration Bot',
    iconURL: 'https://cdn.discordapp.com/embed/avatars/0.png',
  }).setTimestamp();
}

// ── Builder helpers ─────────────────────────────────────────────────────────

/**
 * Creates a success embed.
 * @param {string} title
 * @param {string} description
 * @returns {EmbedBuilder}
 */
function successEmbed(title, description) {
  return setCommonFooter(
    new EmbedBuilder()
      .setColor(PALETTE.SUCCESS)
      .setTitle(`✅  ${title}`)
      .setDescription(description)
  );
}

/**
 * Creates an error embed.
 * @param {string} title
 * @param {string} description
 * @returns {EmbedBuilder}
 */
function errorEmbed(title, description) {
  return setCommonFooter(
    new EmbedBuilder()
      .setColor(PALETTE.DANGER)
      .setTitle(`❌  ${title}`)
      .setDescription(description)
  );
}

/**
 * Creates a warning embed.
 * @param {string} title
 * @param {string} description
 * @returns {EmbedBuilder}
 */
function warningEmbed(title, description) {
  return setCommonFooter(
    new EmbedBuilder()
      .setColor(PALETTE.WARNING)
      .setTitle(`⚠️  ${title}`)
      .setDescription(description)
  );
}

/**
 * Creates an info embed.
 * @param {string} title
 * @param {string} description
 * @returns {EmbedBuilder}
 */
function infoEmbed(title, description) {
  return setCommonFooter(
    new EmbedBuilder()
      .setColor(PALETTE.INFO)
      .setTitle(`ℹ️  ${title}`)
      .setDescription(description)
  );
}

/**
 * Creates a progress embed showing live migration status.
 * @param {object} stats   – { total, checked, migrated, failed, skipped, startTime, jobId, dryRun }
 * @returns {EmbedBuilder}
 */
function progressEmbed(stats) {
  const elapsed = stats.startTime
    ? formatDuration(Date.now() - stats.startTime)
    : 'N/A';

  const progress = stats.total > 0
    ? Math.min(100, Math.round((stats.checked / stats.total) * 100))
    : 0;

  const bar = buildProgressBar(progress);

  return setCommonFooter(
    new EmbedBuilder()
      .setColor(PALETTE.ORANGE)
      .setTitle(`🔄  Migration In Progress${stats.dryRun ? ' (Dry Run)' : ''}`)
      .setDescription(`**Job ID:** \`${stats.jobId}\``)
      .addFields(
        { name: '📊 Progress', value: `${bar} **${progress}%**`, inline: false },
        { name: '👥 Total Members', value: `\`${stats.total.toLocaleString()}\``, inline: true },
        { name: '🔍 Checked', value: `\`${stats.checked.toLocaleString()}\``, inline: true },
        { name: '\u200B', value: '\u200B', inline: true },
        { name: '✅ Migrated', value: `\`${stats.migrated.toLocaleString()}\``, inline: true },
        { name: '❌ Failed', value: `\`${stats.failed.toLocaleString()}\``, inline: true },
        { name: '⏭️ Skipped', value: `\`${stats.skipped.toLocaleString()}\``, inline: true },
        { name: '⏱️ Elapsed', value: `\`${elapsed}\``, inline: true },
        { name: '⏳ ETA', value: `\`${estimateETA(stats)}\``, inline: true },
      )
  );
}

/**
 * Creates the migration report embed posted to the log channel on completion.
 * @param {object} report
 * @returns {EmbedBuilder}
 */
function migrationReportEmbed(report) {
  const {
    jobId, guildName, sourceRole, targetRole,
    initiator, startTime, endTime,
    total, migrated, failed, skipped,
    removeOldRole, includeBots, dryRun, cancelledAt,
  } = report;

  const duration = startTime && endTime
    ? formatDuration(endTime - startTime)
    : 'N/A';

  const status = cancelledAt
    ? '🛑 Cancelled'
    : failed > 0
    ? '⚠️ Completed with errors'
    : '✅ Completed successfully';

  const color = cancelledAt ? PALETTE.DANGER : failed > 0 ? PALETTE.WARNING : PALETTE.SUCCESS;

  return setCommonFooter(
    new EmbedBuilder()
      .setColor(color)
      .setTitle(`📋  Migration Report — ${status}`)
      .setDescription(
        `**Server:** ${guildName}\n**Job ID:** \`${jobId}\`${dryRun ? '\n> ⚠️ This was a **dry run** — no changes were applied.' : ''}`
      )
      .addFields(
        { name: '👤 Administrator', value: initiator, inline: true },
        { name: '🏷️ Source Role', value: `<@&${sourceRole.id}> \`${sourceRole.name}\``, inline: true },
        { name: '🎯 Target Role', value: `<@&${targetRole.id}> \`${targetRole.name}\``, inline: true },
        { name: '🕐 Started', value: `<t:${Math.floor(startTime / 1000)}:f>`, inline: true },
        { name: '🕐 Ended', value: endTime ? `<t:${Math.floor(endTime / 1000)}:f>` : 'N/A', inline: true },
        { name: '⏱️ Duration', value: `\`${duration}\``, inline: true },
        { name: '👥 Total Checked', value: `\`${total.toLocaleString()}\``, inline: true },
        { name: '✅ Migrated', value: `\`${migrated.toLocaleString()}\``, inline: true },
        { name: '❌ Failed', value: `\`${failed.toLocaleString()}\``, inline: true },
        { name: '⏭️ Skipped', value: `\`${skipped.toLocaleString()}\``, inline: true },
        { name: '🗑️ Remove Old Role', value: removeOldRole ? 'Yes' : 'No', inline: true },
        { name: '🤖 Include Bots', value: includeBots ? 'Yes' : 'No', inline: true },
      )
  );
}

/**
 * Creates the confirmation embed shown before migration starts.
 * @param {object} params
 * @returns {EmbedBuilder}
 */
function confirmationEmbed({ sourceRole, targetRole, memberCount, removeOldRole, includeBots, dryRun, estimatedTime }) {
  return setCommonFooter(
    new EmbedBuilder()
      .setColor(PALETTE.WARNING)
      .setTitle('⚠️  Confirm Role Migration')
      .setDescription(
        `You are about to migrate **${memberCount.toLocaleString()} member(s)** from **${sourceRole.name}** → **${targetRole.name}**.\n\n` +
        `React or click the buttons below to confirm or cancel.`
      )
      .addFields(
        { name: '🏷️ Source Role', value: `<@&${sourceRole.id}>`, inline: true },
        { name: '🎯 Target Role', value: `<@&${targetRole.id}>`, inline: true },
        { name: '\u200B', value: '\u200B', inline: true },
        { name: '🗑️ Remove Old Role', value: removeOldRole ? '✅ Yes' : '❌ No', inline: true },
        { name: '🤖 Include Bots', value: includeBots ? '✅ Yes' : '❌ No', inline: true },
        { name: '🔍 Dry Run', value: dryRun ? '✅ Yes (no changes)' : '❌ No (live)', inline: true },
        { name: '⏳ Estimated Time', value: `\`${estimatedTime}\``, inline: true },
      )
  );
}

// ── Utility functions ───────────────────────────────────────────────────────

/**
 * Formats a duration in milliseconds to a human-readable string.
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours   = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (hours)   parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);

  return parts.join(' ');
}

/**
 * Builds a Unicode progress bar.
 * @param {number} percent 0–100
 * @returns {string}
 */
function buildProgressBar(percent) {
  const total = 20;
  const filled = Math.round((percent / 100) * total);
  const empty  = total - filled;
  return `${'█'.repeat(filled)}${'░'.repeat(empty)}`;
}

/**
 * Estimates remaining time based on processing speed.
 * @param {object} stats
 * @returns {string}
 */
function estimateETA(stats) {
  if (!stats.startTime || stats.checked === 0) return 'Calculating…';
  const elapsed = Date.now() - stats.startTime;
  const rate    = stats.checked / elapsed; // members per ms
  const remaining = stats.total - stats.checked;
  if (rate <= 0) return 'Calculating…';
  return formatDuration(Math.ceil(remaining / rate));
}

module.exports = {
  successEmbed,
  errorEmbed,
  warningEmbed,
  infoEmbed,
  progressEmbed,
  migrationReportEmbed,
  confirmationEmbed,
  formatDuration,
  buildProgressBar,
  estimateETA,
  PALETTE,
};
