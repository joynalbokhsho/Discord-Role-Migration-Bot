'use strict';
const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');


const migrationService = require('../services/migrationService');
const db               = require('../database/database');
const logger           = require('../utils/logger');
const { successEmbed, warningEmbed, errorEmbed, infoEmbed } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('cancel-migration')
    .setDescription('Cancel the currently running migration safely')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });


    const { guild } = interaction;

    // Check if a migration is actually running
    const { active, job } = migrationService.getMigrationStatus(guild.id);

    if (!active || !job) {
      return interaction.editReply({
        embeds: [infoEmbed('No Active Migration', 'There is no migration currently running on this server.')],
      });
    }

    // Request cancellation
    const cancelledJobId = migrationService.cancelMigration(guild.id);

    if (!cancelledJobId) {
      return interaction.editReply({
        embeds: [warningEmbed('Could Not Cancel', 'The migration could not be cancelled. It may have already finished.')],
      });
    }

    logger.info(`[Command] /cancel-migration: Job ${cancelledJobId} cancelled by ${interaction.user.tag}`);

    return interaction.editReply({
      embeds: [successEmbed(
        'Migration Cancelled',
        `The migration **\`${cancelledJobId}\`** has been marked for cancellation.\n\n` +
        'The current batch will finish processing, then the job will stop safely.\n' +
        'A final report will be posted to the log channel.'
      )],
    });
  },
};
