'use strict';
const logger = require('./logger');
const config = require('../config/config');

// ── sleep helper ────────────────────────────────────────────────────────────

/**
 * Returns a promise that resolves after `ms` milliseconds.
 * Used to throttle API calls and avoid Discord rate limits.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Retry wrapper ───────────────────────────────────────────────────────────

/**
 * Executes an async function with exponential back-off retry logic.
 *
 * @param {Function} fn           – Async function to execute
 * @param {number}   maxRetries   – Maximum retry attempts
 * @param {number}   baseDelay    – Initial delay in ms (doubles each attempt)
 * @param {string}   context      – Label used in log messages
 * @returns {Promise<any>}
 */
async function withRetry(fn, maxRetries = config.rateLimiting.maxRetries, baseDelay = 1000, context = 'operation') {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Discord.js v14 rate limit errors:
      // - err.status === 429  (HTTP rate limit)
      // - err.retryAfter     in milliseconds (already converted by discord.js)
      // - err.code === 'RateLimitError' or similar
      const isRateLimit = err.status === 429 || err.code === 429 ||
        err.constructor?.name?.includes('RateLimit');

      if (isRateLimit) {
        // discord.js v14 sets retryAfter in ms; older versions in seconds
        const retryAfterMs = err.retryAfter
          ? (err.retryAfter > 1000 ? err.retryAfter : err.retryAfter * 1000)
          : baseDelay * attempt;
        logger.warn(
          `[Retry] Rate-limited on "${context}" — waiting ${retryAfterMs}ms ` +
          `(attempt ${attempt}/${maxRetries})`
        );
        await sleep(retryAfterMs);
        continue;
      }

      if (attempt > maxRetries) break;

      const delay = baseDelay * Math.pow(2, attempt - 1); // exponential back-off
      logger.warn(
        `[Retry] "${context}" failed (attempt ${attempt}/${maxRetries}) — ` +
        `retrying in ${delay}ms. Error: ${err.message}`
      );
      await sleep(delay);
    }
  }

  logger.error(`[Retry] "${context}" failed after ${maxRetries} retries.`, { error: lastError?.message });
  throw lastError;
}

// ── Rate-limit queue ────────────────────────────────────────────────────────

/**
 * Simple sequential queue that enforces a minimum delay between tasks.
 * Prevents Discord rate-limit errors on large batch operations.
 */
class RateLimitQueue {
  /**
   * @param {number} delayMs – Minimum delay between tasks in ms
   */
  constructor(delayMs = config.rateLimiting.delayMs) {
    this.delayMs   = delayMs;
    this.queue     = [];
    this.running   = false;
    this.paused    = false;
    this._lastRun  = 0;
  }

  /**
   * Adds a task to the queue and starts processing if not already running.
   * @param {Function} task – Async function returning a Promise
   * @returns {Promise<any>} – Resolves when the task completes
   */
  enqueue(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this._process();
    });
  }

  /** Pauses processing after the current task finishes. */
  pause() { this.paused = true; }

  /** Resumes processing. */
  resume() {
    this.paused = false;
    this._process();
  }

  /** Cancels all pending tasks with an error. */
  cancelAll(reason = 'Queue cancelled') {
    const pending = this.queue.splice(0);
    for (const { reject } of pending) {
      reject(new Error(reason));
    }
  }

  /** Returns the number of tasks waiting in the queue. */
  get size() { return this.queue.length; }

  /** Internal: processes queued tasks sequentially with delay. */
  async _process() {
    if (this.running || this.paused) return;
    this.running = true;

    while (this.queue.length > 0 && !this.paused) {
      const { task, resolve, reject } = this.queue.shift();

      // Enforce minimum delay between calls
      const sinceLastRun = Date.now() - this._lastRun;
      if (sinceLastRun < this.delayMs) {
        await sleep(this.delayMs - sinceLastRun);
      }

      try {
        this._lastRun = Date.now();
        resolve(await task());
      } catch (err) {
        // If this task was rate-limited, add an extra pause before the next
        // task to let Discord's rate-limit window reset.
        if (err.status === 429 || err.code === 429 || err.constructor?.name?.includes('RateLimit')) {
          const extra = err.retryAfter
            ? (err.retryAfter > 1000 ? err.retryAfter : err.retryAfter * 1000)
            : this.delayMs * 2;
          logger.warn(`[Queue] Rate-limited — pausing queue for ${extra}ms before next item.`);
          await sleep(extra);
        }
        reject(err);
      }
    }

    this.running = false;
  }
}

// ── Permission helpers ──────────────────────────────────────────────────────

/**
 * Checks that the bot has the required permissions to perform a migration.
 *
 * @param {Guild}       guild
 * @param {GuildMember} botMember
 * @param {Role}        targetRole
 * @param {TextChannel} logChannel  – nullable
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateBotPermissions(guild, botMember, targetRole, logChannel) {
  const errors = [];

  if (!botMember.permissions.has('ManageRoles')) {
    errors.push('Bot is missing the **Manage Roles** permission.');
  }

  // Bot's highest role must be above the target role in the hierarchy
  if (targetRole && botMember.roles.highest.comparePositionTo(targetRole) <= 0) {
    errors.push(
      `Bot's highest role (**${botMember.roles.highest.name}**) must be above the target role (**${targetRole.name}**) in the role hierarchy.`
    );
  }

  if (logChannel && !logChannel.permissionsFor(botMember).has('SendMessages')) {
    errors.push(`Bot cannot send messages in the configured log channel <#${logChannel.id}>.`);
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Verifies that a role is safe to assign (not @everyone, not managed by an integration).
 * @param {Role} role
 * @returns {{ ok: boolean, reason: string|null }}
 */
function validateRole(role) {
  if (role.managed)  return { ok: false, reason: `Role **${role.name}** is managed by an integration and cannot be assigned.` };
  if (role.id === role.guild.id) return { ok: false, reason: 'Cannot target the **@everyone** role.' };
  return { ok: true, reason: null };
}

// ── Time utilities ──────────────────────────────────────────────────────────

/**
 * Estimates migration completion time based on member count and delay settings.
 * @param {number} memberCount
 * @returns {string}
 */
function estimateMigrationTime(memberCount) {
  const { delayMs, batchSize } = config.rateLimiting;
  // Worst case: every member needs a role update
  const totalMs = memberCount * delayMs;
  const { formatDuration } = require('./embeds');
  return formatDuration(totalMs);
}

// ── Chunk helper ────────────────────────────────────────────────────────────

/**
 * Splits an array into chunks of the given size.
 * @param {Array}  arr
 * @param {number} size
 * @returns {Array[]}
 */
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

module.exports = {
  sleep,
  withRetry,
  RateLimitQueue,
  validateBotPermissions,
  validateRole,
  estimateMigrationTime,
  chunkArray,
};
