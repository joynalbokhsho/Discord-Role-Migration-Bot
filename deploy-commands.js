'use strict';
require('dotenv').config();

/**
 * deploy-commands.js
 *
 * Registers (or re-registers) all slash commands with Discord's API.
 *
 * Usage:
 *   node deploy-commands.js          → Deploy GLOBALLY (takes ~1 hour to propagate)
 *   node deploy-commands.js --guild  → Deploy to GUILD_ID only (instant, for testing)
 */

const { REST, Routes } = require('discord.js');
const fs   = require('fs');
const path = require('path');

const config = require('./config/config');
const logger = require('./utils/logger');

// ── Load command data ─────────────────────────────────────────────────────

const commands = [];
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));

for (const file of commandFiles) {
  try {
    const command = require(path.join(commandsPath, file));
    if (command?.data) {
      commands.push(command.data.toJSON());
      logger.debug(`[Deploy] Queued command: /${command.data.name}`);
    }
  } catch (err) {
    logger.error(`[Deploy] Failed to load ${file}: ${err.message}`);
  }
}

logger.info(`[Deploy] Prepared ${commands.length} command(s) for registration.`);

// ── Determine deployment scope ────────────────────────────────────────────

const guildMode = process.argv.includes('--guild');

if (guildMode && !config.discord.guildId) {
  logger.error('[Deploy] --guild flag requires GUILD_ID to be set in .env');
  process.exit(1);
}

// ── Register with Discord API ─────────────────────────────────────────────

const rest = new REST({ version: '10' }).setToken(config.discord.token);

(async () => {
  try {
    if (guildMode) {
      logger.info(`[Deploy] Registering ${commands.length} guild commands to guild ${config.discord.guildId}…`);
      await rest.put(
        Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId),
        { body: commands }
      );
      logger.info('[Deploy] ✅  Guild commands registered successfully (instant).');
    } else {
      logger.info(`[Deploy] Registering ${commands.length} global commands (may take up to 1 hour to propagate)…`);
      await rest.put(
        Routes.applicationCommands(config.discord.clientId),
        { body: commands }
      );
      logger.info('[Deploy] ✅  Global commands registered successfully.');
    }
  } catch (err) {
    logger.error(`[Deploy] Failed to register commands: ${err.message}`, { stack: err.stack });
    process.exit(1);
  }
})();
