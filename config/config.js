'use strict';
require('dotenv').config();

/**
 * Central configuration module.
 * All environment variables are validated and exported from here
 * so the rest of the app never reads process.env directly.
 */

// ── Validation helpers ──────────────────────────────────────────────────────

/**
 * Reads an environment variable and throws if it is missing/empty.
 * @param {string} key
 * @returns {string}
 */
function required(key) {
  const value = process.env[key];
  if (!value || value.trim() === '') {
    throw new Error(`[Config] Missing required environment variable: ${key}`);
  }
  return value.trim();
}

/**
 * Reads an environment variable with a fallback default.
 * @param {string} key
 * @param {string} defaultValue
 * @returns {string}
 */
function optional(key, defaultValue = '') {
  return (process.env[key] || defaultValue).trim();
}

/**
 * Parses an integer env var with a fallback.
 * @param {string} key
 * @param {number} defaultValue
 * @returns {number}
 */
function optionalInt(key, defaultValue) {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const parsed = parseInt(raw, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

// ── Exported configuration ──────────────────────────────────────────────────

module.exports = {
  // Discord credentials
  discord: {
    token: required('DISCORD_TOKEN'),
    clientId: required('CLIENT_ID'),
    guildId: optional('GUILD_ID'), // empty = global deployment
  },

  // Channel IDs
  channels: {
    logChannelId: optional('LOG_CHANNEL_ID'),
  },

  // Database
  database: {
    url: optional('DATABASE_URL', './database/migrations.db'),
  },

  // Rate-limit & batching tuning
  rateLimiting: {
    delayMs: optionalInt('RATE_LIMIT_DELAY', 1200),  // ms between each role API call (Discord limit ~10/10s per guild)
    batchSize: optionalInt('BATCH_SIZE', 10),         // members processed per tick
    maxRetries: optionalInt('MAX_RETRIES', 3),        // retry attempts for failed updates
  },

  // Logging
  logging: {
    level: optional('LOG_LEVEL', 'info'),
    webhookUrl: optional('WEBHOOK_URL'),
  },

  // Environment
  env: optional('NODE_ENV', 'production'),
};
