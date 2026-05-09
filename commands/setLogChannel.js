'use strict';
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');


const db     = require('../database/database');
const logger = require('../utils/logger');
const { successEmbed, errorEmbed } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set-log-channel')
    .setDescription('Configure the channel where migration logs and reports are sent')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(opt =>
      opt.setName('channel')
        .setDescription('The text channel to use for migration logs')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });


    const { guild } = interaction;
    const channel   = interaction.options.getChannel('channel');

    // Verify the bot can send messages in this channel
    const botMember = await guild.members.fetchMe();
    if (!channel.permissionsFor(botMember).has('SendMessages')) {
      return interaction.editReply({
        embeds: [errorEmbed(
          'Missing Permission',
          `I don't have permission to send messages in <#${channel.id}>.\nPlease grant me the **Send Messages** permission in that channel.`
        )],
      });
    }

    // Persist to database
    db.setConfig(guild.id, 'logChannelId', channel.id);

    logger.info(`[Command] /set-log-channel: Set to #${channel.name} (${channel.id}) by ${interaction.user.tag} in ${guild.name}`);

    // Send a test message to the channel to confirm it's working
    try {
      await channel.send({
        embeds: [successEmbed(
          'Log Channel Configured',
          `This channel has been set as the migration log channel by <@${interaction.user.id}>.\nFuture migration reports and progress updates will appear here.`
        )],
      });
    } catch (err) {
      logger.warn(`[Command] Could not send test message to log channel: ${err.message}`);
    }

    return interaction.editReply({
      embeds: [successEmbed(
        'Log Channel Set',
        `Migration logs will now be sent to <#${channel.id}>.`
      )],
    });
  },
};
