'use strict';
const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  MessageFlags,
  ChannelType,
} = require('discord.js');

const logger      = require('../utils/logger');
const { PALETTE } = require('../utils/embeds');

// Discord message content limit: 2000 chars.
// Each mention `<@ID>` = up to 22 chars + 1 space = 23 chars.
// 80 mentions × 23 = ~1840 chars — safely under the limit.
const MENTIONS_PER_MSG = 80;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('list-role-members')
    .setDescription('List all members who have a specific role')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption(opt =>
      opt.setName('role')
        .setDescription('The role to list members for')
        .setRequired(true)
    )
    .addChannelOption(opt =>
      opt.setName('post_to_channel')
        .setDescription('Post the list publicly to this channel')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false)
    )
    .addBooleanOption(opt =>
      opt.setName('include_bots')
        .setDescription('Include bots in the list? (default: false)')
        .setRequired(false)
    ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const { guild }   = interaction;
    const role        = interaction.options.getRole('role');
    const postChannel = interaction.options.getChannel('post_to_channel') ?? null;
    const includeBots = interaction.options.getBoolean('include_bots') ?? false;

    // ── Fetch members only if cache is incomplete ────────────────────────────
    // Avoids hitting the Discord Gateway opcode-8 rate limit when the command
    // is used multiple times in a short period on the same server.
    const cacheComplete = guild.members.cache.size >= guild.memberCount;
    if (!cacheComplete) {
      try {
        await guild.members.fetch();
      } catch (err) {
        // Rate-limited or WebSocket error — fall back to whatever is cached.
        // The list may be slightly incomplete but won't crash the bot.
        logger.warn(`[Command] /list-role-members: member fetch failed (${err.message}), using cache.`);
      }
    }

    // ── Get members who have this role ────────────────────────────────────────
    const roleMembers = guild.roles.cache.get(role.id)?.members ?? new Map();
    const filtered    = [...roleMembers.values()].filter(m => includeBots || !m.user.bot);

    logger.info(
      `[Command] /list-role-members: role="${role.name}" | count=${filtered.length} | ` +
      `channel=${postChannel?.name ?? 'ephemeral'} | bots=${includeBots} | by ${interaction.user.tag}`
    );

    // ── No members ────────────────────────────────────────────────────────────
    if (filtered.length === 0) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(PALETTE.WARNING)
            .setTitle('⚠️  No Members Found')
            .setDescription(`No ${includeBots ? '' : 'human '}members currently have the role <@&${role.id}>.`)
            .setTimestamp()
            .setFooter({ text: 'Discord Role Migration Bot' }),
        ],
      });
    }

    // ── Sort by display name alphabetically ───────────────────────────────────
    const sorted = [...filtered].sort((a, b) =>
      a.displayName.localeCompare(b.displayName)
    );

    // ── Split members into content-sized chunks ───────────────────────────────
    // Mentions go in message CONTENT (not embed description) with parse: ['users']
    // so Discord fully resolves every <@ID> as a clickable, interactive mention.
    const pages      = chunkArray(sorted, MENTIONS_PER_MSG);
    const totalPages = pages.length;

    // ── Header / summary embed ────────────────────────────────────────────────
    const headerEmbed = new EmbedBuilder()
      .setColor(role.color || PALETTE.SUCCESS)
      .setTitle(`👥  @${role.name} Members`)
      .addFields(
        // Show both the role mention AND plain text name — if the role is deleted later,
        // the plain text name remains readable in the embed history.
        { name: '🏷️ Role',          value: `<@&${role.id}>\n\`${role.name}\``,                                       inline: true },
        { name: '👥 Total',         value: `**${filtered.length.toLocaleString()}**${includeBots ? '' : ' (humans)'}`, inline: true },
        { name: '📄 Messages',      value: `**${totalPages}**`,                                                        inline: true },
        { name: '📢 Posted To',     value: postChannel ? `<#${postChannel.id}>` : '*Visible to you only*',             inline: true },
        { name: '🤖 Bots Included', value: includeBots ? 'Yes' : 'No',                                                inline: true },
        { name: '🔤 Sorted',        value: 'Alphabetically',                                                           inline: true },
      )
      .setTimestamp()
      .setFooter({ text: `Discord Role Migration Bot  •  Role ID: ${role.id}` });

    if (postChannel) {
      // ── Permission check ───────────────────────────────────────────────────
      const botMember = await guild.members.fetchMe();
      if (!postChannel.permissionsFor(botMember).has('SendMessages')) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(PALETTE.DANGER)
              .setTitle('❌  Missing Permission')
              .setDescription(`I can't send messages in <#${postChannel.id}>. Please grant me **Send Messages** there.`)
              .setTimestamp()
              .setFooter({ text: 'Discord Role Migration Bot' }),
          ],
        });
      }

      // ── Post header embed to target channel ────────────────────────────────
      await postChannel.send({ embeds: [headerEmbed] });

      // ── Post each mention chunk as plain content with full mention parsing ─
      // parse: ['users'] makes Discord resolve every <@ID> as a real clickable
      // mention with full profile popup support.
      for (let i = 0; i < pages.length; i++) {
        const chunk    = pages[i];
        const mentions = chunk.map(m => `<@${m.id}>`).join(' ');
        const label    = totalPages > 1 ? `**Page ${i + 1}/${totalPages}**\n` : '';
        await postChannel.send({
          content: label + mentions,
          allowedMentions: { parse: ['users'] }, // fully resolve all mentions → clickable profiles
        });
      }

      // ── Ephemeral confirmation to admin ────────────────────────────────────
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(PALETTE.SUCCESS)
            .setTitle('✅  List Posted')
            .setDescription(
              `**${filtered.length.toLocaleString()}** member(s) with <@&${role.id}> ` +
              `posted to <#${postChannel.id}> across **${totalPages + 1}** message(s).`
            )
            .setTimestamp()
            .setFooter({ text: 'Discord Role Migration Bot' }),
        ],
      });

    } else {
      // ── Ephemeral-only: show summary + mention chunks only to admin ──────────
      await interaction.editReply({ embeds: [headerEmbed] });

      for (let i = 0; i < pages.length; i++) {
        const chunk    = pages[i];
        const mentions = chunk.map(m => `<@${m.id}>`).join(' ');
        const label    = totalPages > 1 ? `**Page ${i + 1}/${totalPages}**\n` : '';
        await interaction.followUp({
          content: label + mentions,
          allowedMentions: { parse: ['users'] },
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  },
};

// ── Utility ───────────────────────────────────────────────────────────────────

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
