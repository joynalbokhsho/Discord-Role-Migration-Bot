'use strict';
const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  AttachmentBuilder,
  MessageFlags,
} = require('discord.js');

const fs = require('fs');

const migrationService = require('../services/migrationService');
const db               = require('../database/database');
const logger           = require('../utils/logger');
const { successEmbed, errorEmbed, infoEmbed } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('export-migration')
    .setDescription('Export migration results to JSON and CSV files')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt =>
      opt.setName('job_id')
        .setDescription('Job ID to export (defaults to most recent job)')
        .setRequired(false)
    ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });


    const { guild } = interaction;
    let jobId       = interaction.options.getString('job_id');

    // Resolve to most recent job if not specified
    if (!jobId) {
      const recent = db.getRecentJobs(guild.id, 1);
      if (!recent.length) {
        return interaction.editReply({
          embeds: [infoEmbed('No Jobs Found', 'No migration jobs exist for this server.')],
        });
      }
      jobId = recent[0].id;
    }

    // Verify job belongs to this guild
    const job = db.getJob(jobId);
    if (!job || job.guild_id !== guild.id) {
      return interaction.editReply({
        embeds: [errorEmbed('Job Not Found', `No migration job with ID \`${jobId}\` was found for this server.`)],
      });
    }

    // Generate export files
    let paths;
    try {
      paths = migrationService.exportMigrationResults(jobId);
    } catch (err) {
      logger.error(`[Command] /export-migration: ${err.message}`);
      return interaction.editReply({
        embeds: [errorEmbed('Export Failed', err.message)],
      });
    }

    // Attach files to the reply
    const attachments = [
      new AttachmentBuilder(paths.jsonPath, { name: `migration_${jobId.split('-')[0]}.json` }),
      new AttachmentBuilder(paths.csvPath,  { name: `migration_${jobId.split('-')[0]}.csv` }),
    ];

    logger.info(`[Command] /export-migration: Exported job ${jobId} by ${interaction.user.tag}`);

    return interaction.editReply({
      embeds: [successEmbed(
        'Export Complete',
        `Migration results for job \`${jobId}\` have been exported.\n\n` +
        `📊 **${job.migrated}** migrated | ❌ **${job.failed}** failed | ⏭️ **${job.skipped}** skipped`
      )],
      files: attachments,
    });
  },
};
