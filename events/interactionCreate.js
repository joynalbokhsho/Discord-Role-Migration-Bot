'use strict';
const { Events, MessageFlags } = require('discord.js');

const logger = require('../utils/logger');
const { errorEmbed } = require('../utils/embeds');

/**
 * interactionCreate — Routes slash commands to their handlers.
 * Handles unknown commands and runtime errors gracefully.
 */
module.exports = {
  name: Events.InteractionCreate,
  once: false,

  /**
   * @param {import('discord.js').Interaction} interaction
   */
  async execute(interaction) {
    // Only handle slash commands
    if (!interaction.isChatInputCommand()) return;

    const command = interaction.client.commands.get(interaction.commandName);

    if (!command) {
      logger.warn(`[InteractionCreate] Unknown command: /${interaction.commandName}`);
      // Try to reply if we can — avoid silent failures
      if (interaction.replied || interaction.deferred) return;
      try {
        await interaction.reply({
          embeds: [errorEmbed('Unknown Command', `No command named \`/${interaction.commandName}\` was found.`)],
          ephemeral: true,
        });
      } catch { /* ignore */ }
      return;
    }

    // ── Execute command ─────────────────────────────────────────────────────

    try {
      logger.info(
        `[Command] /${interaction.commandName} by ${interaction.user.tag} ` +
        `in guild "${interaction.guild?.name}" (${interaction.guild?.id})`
      );
      await command.execute(interaction);
    } catch (err) {
      logger.error(`[Command] Error in /${interaction.commandName}: ${err.message}`, { stack: err.stack });

      const errorPayload = {
        embeds: [errorEmbed('Command Error', `An unexpected error occurred while running this command.\n\`\`\`${err.message}\`\`\``)],
        flags: MessageFlags.Ephemeral,
      };

      // Reply or follow up depending on interaction state
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(errorPayload).catch(() => {});
      } else {
        await interaction.reply(errorPayload).catch(() => {});
      }
    }
  },
};
