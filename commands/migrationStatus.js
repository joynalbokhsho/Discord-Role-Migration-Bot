'use strict';
const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');


const migrationService = require('../services/migrationService');
const db               = require('../database/database');
const logger           = require('../utils/logger');
const { infoEmbed, warningEmbed, PALETTE } = require('../utils/embeds');
const { formatDuration, buildProgressBar, estimateETA } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('migration-status')
    .setDescription('Show the status of the active or most recent migration')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });


    const { guild } = interaction;
    const { active, job, state } = migrationService.getMigrationStatus(guild.id);

    // No active job — show the most recent completed job instead
    if (!job) {
      const recentJobs = db.getRecentJobs(guild.id, 1);
      if (recentJobs.length === 0) {
        return interaction.editReply({
          embeds: [infoEmbed('No Migration Found', 'No migration jobs have been run on this server yet.')],
        });
      }
      const lastJob = recentJobs[0];
      return interaction.editReply({ embeds: [buildJobStatusEmbed(lastJob, false)] });
    }

    return interaction.editReply({ embeds: [buildJobStatusEmbed(job, active)] });
  },
};

// ── Status embed builder ─────────────────────────────────────────────────

/**
 * Builds a detailed status embed for a job row.
 * @param {object}  job
 * @param {boolean} isActive
 * @returns {EmbedBuilder}
 */
function buildJobStatusEmbed(job, isActive) {
  const elapsed = job.started_at
    ? formatDuration(Date.now() - job.started_at)
    : 'N/A';

  const progress = job.total_members > 0
    ? Math.min(100, Math.round((job.checked / job.total_members) * 100))
    : 0;

  const bar = buildProgressBar(progress);

  const statusIcon = {
    running:   '🔄',
    completed: '✅',
    failed:    '❌',
    cancelled: '🛑',
    pending:   '⏳',
  }[job.status] || '❓';

  const color = {
    running:   PALETTE.ORANGE,
    completed: PALETTE.SUCCESS,
    failed:    PALETTE.DANGER,
    cancelled: PALETTE.DANGER,
    pending:   PALETTE.INFO,
  }[job.status] || PALETTE.NEUTRAL;

  const eta = isActive
    ? estimateETA({
        total: job.total_members,
        checked: job.checked,
        startTime: job.started_at,
      })
    : 'N/A';

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`${statusIcon}  Migration Status — ${job.status.toUpperCase()}`)
    .setDescription(
      `**Job ID:** \`${job.id}\`\n` +
      `**Server:** ${job.guild_name}\n` +
      (job.dry_run ? '> ⚠️ This is/was a **dry run**.\n' : '')
    )
    .addFields(
      { name: '🏷️ Source Role', value: `\`${job.source_role_name}\``, inline: true },
      { name: '🎯 Target Role', value: `\`${job.target_role_name}\``, inline: true },
      { name: '\u200B', value: '\u200B', inline: true },
      { name: '📊 Progress', value: `${bar} **${progress}%**`, inline: false },
      { name: '👥 Total Members', value: `\`${job.total_members.toLocaleString()}\``, inline: true },
      { name: '🔍 Checked',       value: `\`${job.checked.toLocaleString()}\``,       inline: true },
      { name: '\u200B', value: '\u200B', inline: true },
      { name: '✅ Migrated', value: `\`${job.migrated.toLocaleString()}\``, inline: true },
      { name: '❌ Failed',   value: `\`${job.failed.toLocaleString()}\``,   inline: true },
      { name: '⏭️ Skipped',  value: `\`${job.skipped.toLocaleString()}\``,  inline: true },
      { name: '⏱️ Elapsed',  value: `\`${elapsed}\``, inline: true },
      { name: '⏳ ETA',      value: `\`${eta}\``,     inline: true },
      { name: '👤 Started by', value: `\`${job.initiator_tag}\``, inline: true },
    )
    .setTimestamp()
    .setFooter({ text: 'Discord Role Migration Bot' });
}
