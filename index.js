'use strict';
require('dotenv').config();

// Suppress Node.js ExperimentalWarning for built-in node:sqlite
// (stable enough for production in Node v22 — warning is purely informational)
const originalEmit = process.emit;
process.emit = function (event, warning, ...args) {
  if (event === 'warning' && warning?.name === 'ExperimentalWarning' &&
      warning?.message?.includes('SQLite')) {
    return false;
  }
  return originalEmit.call(this, event, warning, ...args);
};

const fs      = require('fs');
const path    = require('path');
const {
  Client,
  GatewayIntentBits,
  Partials,
  Collection,
} = require('discord.js');

const config  = require('./config/config');
const logger  = require('./utils/logger');
const db      = require('./database/database');

// ── Create Discord client ─────────────────────────────────────────────────

/**
 * Intents required for the role migration bot:
 * - Guilds: basic guild info, roles, channels
 * - GuildMembers: fetch all members (required for large servers — must be enabled in Dev Portal)
 * - GuildMessages: read messages for confirmation buttons
 * - MessageContent: read message content (needed for some interactions)
 */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,   // ⚠️  Privileged intent — enable in Discord Dev Portal
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // ⚠️  Privileged intent — enable in Discord Dev Portal
  ],
  partials: [Partials.GuildMember],
});

// ── Command registry ──────────────────────────────────────────────────────

/** Map of commandName → command module, attached to the client. */
client.commands = new Collection();

const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  if (!command?.data?.name || !command?.execute) {
    logger.warn(`[Loader] Skipped ${file} — missing "data.name" or "execute" export.`);
    continue;
  }
  client.commands.set(command.data.name, command);
  logger.debug(`[Loader] Loaded command: /${command.data.name}`);
}

logger.info(`[Loader] Loaded ${client.commands.size} command(s).`);

// ── Event registry ────────────────────────────────────────────────────────

const eventsPath = path.join(__dirname, 'events');
const eventFiles = fs.readdirSync(eventsPath).filter(f => f.endsWith('.js'));

for (const file of eventFiles) {
  const event = require(path.join(eventsPath, file));
  if (!event?.name || !event?.execute) {
    logger.warn(`[Loader] Skipped event ${file} — missing "name" or "execute" export.`);
    continue;
  }

  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args));
  } else {
    client.on(event.name, (...args) => event.execute(...args));
  }
  logger.debug(`[Loader] Registered event: ${event.name} (once=${event.once ?? false})`);
}

logger.info(`[Loader] Registered ${eventFiles.length} event(s).`);

// ── Global error handlers ─────────────────────────────────────────────────

process.on('unhandledRejection', (reason) => {
  // GatewayRateLimitError (opcode 8) and REST rate limits are transient — log and continue
  const msg  = reason?.message || String(reason);
  const name = reason?.name || reason?.constructor?.name || '';
  if (msg.includes('rate limit') || msg.includes('RateLimit') ||
      name.includes('RateLimit') || name.includes('rateLimit')) {
    logger.warn(`[Process] Gateway/REST rate limit hit (non-fatal, auto-handled): ${msg}`);
    return;
  }
  logger.error('[Process] Unhandled Promise Rejection', {
    reason: msg,
    stack:  reason?.stack,
  });
});

process.on('uncaughtException', err => {
  // Swallow transient rate-limit errors — they are not fatal
  const name = err?.name || err?.constructor?.name || '';
  if (err.message?.includes('rate limit') || err.message?.includes('RateLimit') ||
      name.includes('RateLimit') || name.includes('GatewayRateLimit')) {
    logger.warn(`[Process] Gateway rate limit (non-fatal, auto-handled): ${err.message}`);
    return;
  }
  logger.error('[Process] Uncaught Exception — shutting down.', { error: err.message, stack: err.stack });
  gracefulShutdown(1);
});

// Catch Discord.js client-level errors (e.g. websocket drops) without crashing
client.on('error', err => {
  logger.error(`[Client] Discord client error: ${err.message}`);
});

// Log REST rate limit warnings — discord.js handles the retry automatically
client.rest?.on('rateLimited', info => {
  logger.warn(
    `[RateLimit] REST rate limited on ${info.route} — ` +
    `retry after ${info.retryAfter}ms (discord.js will retry automatically, migration continues)`
  );
});

// ── Graceful shutdown ─────────────────────────────────────────────────────

/**
 * Closes database connection and destroys the Discord client cleanly.
 * @param {number} code  – exit code (0 = clean, 1 = error)
 */
async function gracefulShutdown(code = 0) {
  logger.info('[Shutdown] Initiating graceful shutdown…');

  try {
    // Cancel any running migrations
    const { activeJobs } = require('./services/migrationService');
    for (const [guildId, state] of activeJobs.entries()) {
      logger.info(`[Shutdown] Cancelling active migration job: ${state.jobId}`);
      state.cancelRequested = true;
      state.queue.cancelAll('Bot shutting down');
    }

    // Close database
    db.close();

    // Destroy Discord client
    client.destroy();
    logger.info('[Shutdown] Discord client destroyed.');
  } catch (err) {
    logger.error('[Shutdown] Error during shutdown', { error: err.message });
  }

  process.exit(code);
}

// Handle termination signals (Docker, PM2, systemd, etc.)
process.on('SIGTERM', () => gracefulShutdown(0));
process.on('SIGINT',  () => gracefulShutdown(0));

// ── Login ─────────────────────────────────────────────────────────────────

logger.info('[Bot] Starting Discord Role Migration Bot…');

client.login(config.discord.token).catch(err => {
  logger.error(`[Bot] Failed to log in: ${err.message}`);
  process.exit(1);
});
