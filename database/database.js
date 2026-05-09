'use strict';
// node:sqlite is built into Node.js >= v22.5.0 — no external package required
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs   = require('fs');

const config = require('../config/config');
const logger = require('../utils/logger');

// ── Ensure DB directory exists ───────────────────────────────────────────────

const dbPath = path.resolve(config.database.url);
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

// ── Singleton connection ─────────────────────────────────────────────────────

let db;

/**
 * Returns the open SQLite database instance, initialising it on first call.
 * @returns {DatabaseSync}
 */
function getDb() {
  if (!db) {
    db = new DatabaseSync(dbPath);
    // WAL mode for better concurrent-read performance
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    runMigrations(db);
    logger.info(`[Database] Connected to SQLite at: ${dbPath}`);
  }
  return db;
}

// ── Schema migrations ────────────────────────────────────────────────────────

function runMigrations(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const migrations = [{ version: 1, sql: MIGRATION_001 }];

  for (const { version, sql } of migrations) {
    const row = database.prepare(
      'SELECT version FROM schema_migrations WHERE version = ?'
    ).get(version);

    if (!row) {
      database.exec(sql);
      database.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version);
      logger.info(`[Database] Applied migration v${version}`);
    }
  }
}

// ── Initial schema ───────────────────────────────────────────────────────────

const MIGRATION_001 = `
  CREATE TABLE IF NOT EXISTS migration_jobs (
    id               TEXT PRIMARY KEY,
    guild_id         TEXT NOT NULL,
    guild_name       TEXT NOT NULL,
    source_role_id   TEXT NOT NULL,
    source_role_name TEXT NOT NULL,
    target_role_id   TEXT NOT NULL,
    target_role_name TEXT NOT NULL,
    initiator_id     TEXT NOT NULL,
    initiator_tag    TEXT NOT NULL,
    remove_old_role  INTEGER NOT NULL DEFAULT 0,
    include_bots     INTEGER NOT NULL DEFAULT 0,
    dry_run          INTEGER NOT NULL DEFAULT 0,
    status           TEXT NOT NULL DEFAULT 'pending',
    total_members    INTEGER NOT NULL DEFAULT 0,
    checked          INTEGER NOT NULL DEFAULT 0,
    migrated         INTEGER NOT NULL DEFAULT 0,
    failed           INTEGER NOT NULL DEFAULT 0,
    skipped          INTEGER NOT NULL DEFAULT 0,
    started_at       INTEGER,
    completed_at     INTEGER,
    cancelled_at     INTEGER,
    log_channel_id   TEXT,
    created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS migration_member_logs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id       TEXT NOT NULL REFERENCES migration_jobs(id) ON DELETE CASCADE,
    member_id    TEXT NOT NULL,
    username     TEXT NOT NULL,
    result       TEXT NOT NULL,
    reason       TEXT,
    processed_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE INDEX IF NOT EXISTS idx_member_logs_job ON migration_member_logs(job_id);

  CREATE TABLE IF NOT EXISTS bot_config (
    guild_id   TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    PRIMARY KEY (guild_id, key)
  );
`;

// ── DAO layer ────────────────────────────────────────────────────────────────

module.exports = {
  getDb,

  // ── Jobs ──────────────────────────────────────────────────────────────────

  createJob(job) {
    getDb().prepare(`
      INSERT INTO migration_jobs (
        id, guild_id, guild_name,
        source_role_id, source_role_name,
        target_role_id, target_role_name,
        initiator_id, initiator_tag,
        remove_old_role, include_bots, dry_run,
        status, total_members, started_at, log_channel_id
      ) VALUES (
        $id, $guild_id, $guild_name,
        $source_role_id, $source_role_name,
        $target_role_id, $target_role_name,
        $initiator_id, $initiator_tag,
        $remove_old_role, $include_bots, $dry_run,
        $status, $total_members, $started_at, $log_channel_id
      )
    `).run(job);
    return this.getJob(job.id);
  },

  getJob(jobId) {
    return getDb().prepare('SELECT * FROM migration_jobs WHERE id = ?').get(jobId);
  },

  getActiveJob(guildId) {
    return getDb().prepare(
      "SELECT * FROM migration_jobs WHERE guild_id = ? AND status = 'running' ORDER BY created_at DESC LIMIT 1"
    ).get(guildId);
  },

  incrementJobStats(jobId, delta) {
    const parts = [];
    const vals  = [];
    for (const [k, v] of Object.entries(delta)) {
      if (v) { parts.push(`${k} = ${k} + ?`); vals.push(v); }
    }
    if (!parts.length) return;
    vals.push(jobId);
    getDb().prepare(`UPDATE migration_jobs SET ${parts.join(', ')} WHERE id = ?`).run(...vals);
  },

  updateJobStatus(jobId, status, extra = {}) {
    const fields     = { status, ...extra };
    const setClauses = Object.keys(fields).map(k => `${k} = $${k}`).join(', ');
    getDb().prepare(`UPDATE migration_jobs SET ${setClauses} WHERE id = $id`)
      .run({ ...fields, id: jobId });
  },

  getRecentJobs(guildId, limit = 10) {
    return getDb().prepare(
      'SELECT * FROM migration_jobs WHERE guild_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(guildId, limit);
  },

  // ── Member logs ────────────────────────────────────────────────────────────

  logMemberResult(log) {
    getDb().prepare(`
      INSERT INTO migration_member_logs (job_id, member_id, username, result, reason)
      VALUES ($job_id, $member_id, $username, $result, $reason)
    `).run(log);
  },

  getMemberLogs(jobId, resultFilter = null) {
    const db = getDb();
    if (resultFilter) {
      return db.prepare(
        'SELECT * FROM migration_member_logs WHERE job_id = ? AND result = ? ORDER BY id'
      ).all(jobId, resultFilter);
    }
    return db.prepare(
      'SELECT * FROM migration_member_logs WHERE job_id = ? ORDER BY id'
    ).all(jobId);
  },

  // ── Config ─────────────────────────────────────────────────────────────────

  setConfig(guildId, key, value) {
    getDb().prepare(`
      INSERT INTO bot_config (guild_id, key, value, updated_at)
      VALUES ($guild_id, $key, $value, $updated_at)
      ON CONFLICT(guild_id, key) DO UPDATE SET
        value      = excluded.value,
        updated_at = excluded.updated_at
    `).run({ guild_id: guildId, key, value, updated_at: Date.now() });
  },

  getConfig(guildId, key, defaultValue = null) {
    const row = getDb().prepare(
      'SELECT value FROM bot_config WHERE guild_id = ? AND key = ?'
    ).get(guildId, key);
    return row ? row.value : defaultValue;
  },

  close() {
    if (db) {
      db.close();
      db = null;
      logger.info('[Database] Connection closed.');
    }
  },
};
