'use strict';
const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');


const db     = require('../database/database');
const logger = require('../utils/logger');
const { infoEmbed, PALETTE } = require('../utils/embeds');
const { formatDuration }     = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('migration-history')
    .setDescription('View past migration jobs for this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addIntegerOption(opt =>
      opt.setName('limit')
        .setDescription('Number of recent jobs to show (default: 5, max: 10)')
        .setMinValue(1)
        .setMaxValue(10)
        .setRequired(false)
    ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });


    const { guild } = interaction;
    const limit     = interaction.options.getInteger('limit') ?? 5;

    const jobs = db.getRecentJobs(guild.id, limit);

    if (!jobs.length) {
      return interaction.editReply({
        embeds: [infoEmbed('No History', 'No migration jobs have been run on this server yet.')],
      });
    }

    const statusIcon = j => ({ running: '🔄', completed: '✅', failed: '❌', cancelled: '🛑', pending: '⏳' }[j.status] || '❓');

    const rows = jobs.map((j, i) => {
      const duration = j.started_at && j.completed_at
        ? formatDuration(j.completed_at - j.started_at)
        : j.started_at
        ? formatDuration(Date.now() - j.started_at)
        : 'N/A';

      return (
        `**${i + 1}.** ${statusIcon(j)} \`${j.id.split('-')[0]}\`…\n` +
        `> 🏷️ \`${j.source_role_name}\` → 🎯 \`${j.target_role_name}\`\n` +
        `> ✅ ${j.migrated} | ❌ ${j.failed} | ⏭️ ${j.skipped} | ⏱️ ${duration}\n` +
        `> 👤 ${j.initiator_tag} • <t:${Math.floor(j.created_at / 1000)}:R>`
      );
    });

    const embed = new EmbedBuilder()
      .setColor(PALETTE.PRIMARY)
      .setTitle(`📋  Migration History — Last ${jobs.length} Jobs`)
      .setDescription(rows.join('\n\n'))
      .setTimestamp()
      .setFooter({ text: 'Discord Role Migration Bot' });

    return interaction.editReply({ embeds: [embed] });
  },
};
