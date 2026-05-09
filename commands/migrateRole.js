'use strict';
const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ComponentType,
  MessageFlags,
} = require('discord.js');

const migrationService = require('../services/migrationService');
const db               = require('../database/database');
const logger           = require('../utils/logger');
const {
  successEmbed, errorEmbed, warningEmbed,
  confirmationEmbed, infoEmbed,
} = require('../utils/embeds');
const {
  validateBotPermissions, validateRole, estimateMigrationTime,
} = require('../utils/helpers');
const config           = require('../config/config');

// ── Command definition ────────────────────────────────────────────────────

module.exports = {
  data: new SlashCommandBuilder()
    .setName('migrate-role')
    .setDescription('Migrate all members from one role to another')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption(opt =>
      opt.setName('source_role')
        .setDescription('The role members currently have')
        .setRequired(true)
    )
    .addRoleOption(opt =>
      opt.setName('target_role')
        .setDescription('The role members will receive after migration')
        .setRequired(true)
    )
    .addBooleanOption(opt =>
      opt.setName('remove_old_role')
        .setDescription('Remove the source role after assigning the target role? (default: false)')
        .setRequired(false)
    )
    .addBooleanOption(opt =>
      opt.setName('include_bots')
        .setDescription('Include bots in the migration? (default: false)')
        .setRequired(false)
    )
    .addBooleanOption(opt =>
      opt.setName('dry_run')
        .setDescription('Preview migration without applying changes (default: false)')
        .setRequired(false)
    ),

  // ── Handler ─────────────────────────────────────────────────────────────

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    // Ephemeral replies until confirmation step
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const { guild, member: initiatorMember } = interaction;
    const sourceRole    = interaction.options.getRole('source_role');
    const targetRole    = interaction.options.getRole('target_role');
    const removeOldRole = interaction.options.getBoolean('remove_old_role') ?? false;
    const includeBots   = interaction.options.getBoolean('include_bots')   ?? false;
    const dryRun        = interaction.options.getBoolean('dry_run')        ?? false;

    // ── Sanity checks ──────────────────────────────────────────────────────

    if (sourceRole.id === targetRole.id) {
      return interaction.editReply({ embeds: [errorEmbed('Invalid Roles', 'Source and target roles must be different.')] });
    }

    // Validate source role
    const sourceCheck = validateRole(sourceRole);
    if (!sourceCheck.ok) {
      return interaction.editReply({ embeds: [errorEmbed('Invalid Source Role', sourceCheck.reason)] });
    }

    // Validate target role
    const targetCheck = validateRole(targetRole);
    if (!targetCheck.ok) {
      return interaction.editReply({ embeds: [errorEmbed('Invalid Target Role', targetCheck.reason)] });
    }

    // ── Bot permission check ───────────────────────────────────────────────
    const botMember    = await guild.members.fetchMe();
    const logChannelId = db.getConfig(guild.id, 'logChannelId', config.channels.logChannelId);
    let logChannel     = null;
    if (logChannelId) {
      try { logChannel = await guild.channels.fetch(logChannelId); } catch { /* ignore */ }
    }

    const permCheck = validateBotPermissions(guild, botMember, targetRole, logChannel);
    if (!permCheck.ok) {
      return interaction.editReply({
        embeds: [errorEmbed(
          'Bot Permission Error',
          permCheck.errors.join('\n\n')
        )],
      });
    }

    // ── Guard: concurrent job ─────────────────────────────────────────────
    if (migrationService.activeJobs.has(guild.id)) {
      return interaction.editReply({
        embeds: [warningEmbed(
          'Migration Already Running',
          'A migration is already active. Use `/migration-status` to monitor it or `/cancel-migration` to stop it.'
        )],
      });
    }

    // ── Count eligible members without fetching all ───────────────────────
    // Fetch members only if cache is incomplete (avoids opcode-8 rate limit)
    if (guild.members.cache.size < guild.memberCount) {
      try { await guild.members.fetch(); } catch { /* use existing cache */ }
    }
    const sourceMembers = guild.roles.cache.get(sourceRole.id)?.members ?? new Map();
    const eligible      = [...sourceMembers.values()].filter(m => includeBots || !m.user.bot);
    const memberCount   = eligible.length;

    const estimatedTime = estimateMigrationTime(memberCount);

    // ── Confirmation step ─────────────────────────────────────────────────

    const confirmBtn = new ButtonBuilder()
      .setCustomId('confirm_migrate')
      .setLabel('✅  Confirm Migration')
      .setStyle(ButtonStyle.Success);

    const cancelBtn = new ButtonBuilder()
      .setCustomId('cancel_migrate')
      .setLabel('❌  Cancel')
      .setStyle(ButtonStyle.Danger);

    const row = new ActionRowBuilder().addComponents(confirmBtn, cancelBtn);

    const confirmMsg = await interaction.editReply({
      embeds: [confirmationEmbed({ sourceRole, targetRole, memberCount, removeOldRole, includeBots, dryRun, estimatedTime })],
      components: [row],
    });

    // ── Await button response ─────────────────────────────────────────────

    let confirmation;
    try {
      confirmation = await confirmMsg.awaitMessageComponent({
        filter:  c => c.user.id === interaction.user.id,
        time:    60_000, // 60 second window
        componentType: ComponentType.Button,
      });
    } catch {
      // Timeout
      await interaction.editReply({
        embeds: [warningEmbed('Confirmation Timeout', 'Migration was not confirmed within 60 seconds and has been cancelled.')],
        components: [],
      });
      return;
    }

    await confirmation.deferUpdate();

    if (confirmation.customId === 'cancel_migrate') {
      return interaction.editReply({
        embeds: [infoEmbed('Migration Cancelled', 'The migration was cancelled before it started.')],
        components: [],
      });
    }

    // ── Start migration ───────────────────────────────────────────────────

    // Edit reply to show a live progress message
    await interaction.editReply({
      embeds: [infoEmbed('Migration Started', `Job is running in the background.\nUse \`/migration-status\` to monitor progress.\n\n**Job params:**\n• Source: **${sourceRole.name}**\n• Target: **${targetRole.name}**\n• Dry run: **${dryRun ? 'Yes' : 'No'}**`)],
      components: [],
    });

    try {
      const jobId = await migrationService.startMigration({
        guild,
        initiatorMember,
        sourceRole,
        targetRole,
        removeOldRole,
        includeBots,
        dryRun,
        logChannel,
        progressMessage: null, // no live editing on ephemeral reply; handled via log channel
      });

      logger.info(`[Command] /migrate-role started job ${jobId} by ${initiatorMember.user.tag} in ${guild.name}`);
    } catch (err) {
      logger.error(`[Command] /migrate-role failed to start: ${err.message}`);
      await interaction.editReply({
        embeds: [errorEmbed('Migration Failed to Start', err.message)],
        components: [],
      });
    }
  },
};
