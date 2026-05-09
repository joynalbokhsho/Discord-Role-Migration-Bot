<div align="center">

# 🔄 Discord Role Migration Bot

**A production-ready Discord bot for bulk role migrations — with rate limiting, dry-run previews, real-time progress, and full audit logging.**

[![Node.js](https://img.shields.io/badge/Node.js-v22%2B-brightgreen?logo=node.js)](https://nodejs.org)
[![Discord.js](https://img.shields.io/badge/Discord.js-v14-5865F2?logo=discord)](https://discord.js.org)
[![SQLite](https://img.shields.io/badge/Database-SQLite%20(built--in)-blue)](https://nodejs.org/api/sqlite.html)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

</div>

---

## ✨ Features

- **Bulk Role Migration** — Move all members from one role to another with a single command
- **Dry Run Mode** — Preview exactly who would be migrated before making any changes
- **Smart Rate Limiting** — Configurable delay between API calls; auto-respects Discord's rate limits
- **Real-Time Progress** — Live progress bar with ETA updated every 10 seconds
- **Role Member Listing** — List all members with a specific role as clickable mentions, posted to any channel
- **Full Audit Logging** — Every member action (migrated / skipped / failed) is logged to SQLite
- **Job Persistence** — Migration jobs survive bot restarts; full history stored in database
- **Export Results** — Download migration results as JSON or CSV
- **Graceful Cancellation** — Safely stop any running migration mid-way
- **Per-Member Console Logs** — See every role assignment in real time on the console

---

## 📋 Commands

| Command | Description |
|---|---|
| `/migrate-role` | Start a role migration with optional dry-run, keep/remove old role |
| `/migration-status` | View real-time progress, ETA, and stats for the running migration |
| `/cancel-migration` | Safely cancel the active migration after the current batch |
| `/migration-history` | View recent migration jobs for this server |
| `/export-migration` | Export a job's results as JSON or CSV |
| `/set-log-channel` | Set the channel where migration reports are posted |
| `/list-role-members` | List all members with a role as clickable mentions |

---

## 🚀 Setup

### 1. Prerequisites

- [Node.js](https://nodejs.org) **v22.5.0 or higher** (uses built-in `node:sqlite`)
- A Discord application with a bot user — create one at the [Discord Developer Portal](https://discord.com/developers/applications)

### 2. Clone the repository

```bash
git clone https://github.com/your-username/discord-role-migration.git
cd discord-role-migration
```

### 3. Install dependencies

```bash
npm install
```

### 4. Configure environment

```bash
cp .env.example .env
```

Open `.env` and fill in your values:

```env
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_application_client_id_here
GUILD_ID=your_guild_id_here
```

See [Configuration](#%EF%B8%8F-configuration) below for all available options.

### 5. Enable Privileged Intents

In the [Discord Developer Portal](https://discord.com/developers/applications):

1. Go to your application → **Bot** tab
2. Enable **Server Members Intent** ✅
3. Enable **Message Content Intent** ✅

> ⚠️ These intents are required. The bot cannot fetch all guild members without them.

### 6. Invite the bot to your server

Generate an invite URL with these permissions:

- `Manage Roles`
- `Send Messages`
- `Embed Links`
- `Read Message History`

Or use the OAuth2 URL Generator in the Developer Portal with the `bot` and `applications.commands` scopes.

> ⚠️ The bot's role must be **above** any role it needs to assign in the server's role hierarchy.

### 7. Deploy slash commands

```bash
# Deploy to a specific guild (instant — for testing)
node deploy-commands.js --guild

# Deploy globally (takes up to 1 hour to propagate)
node deploy-commands.js
```

### 8. Start the bot

```bash
node index.js
```

---

## ⚙️ Configuration

All configuration is done via the `.env` file. Copy `.env.example` to get started.

| Variable | Required | Default | Description |
|---|---|---|---|
| `DISCORD_TOKEN` | ✅ | — | Your bot token from the Developer Portal |
| `CLIENT_ID` | ✅ | — | Your application's Client ID |
| `GUILD_ID` | ⚡ | — | Guild ID for instant command deployment (recommended for testing) |
| `LOG_CHANNEL_ID` | ❌ | — | Default channel for migration reports (overridable per-server via `/set-log-channel`) |
| `DATABASE_URL` | ❌ | `./database/migrations.db` | Path to the SQLite database file |
| `RATE_LIMIT_DELAY` | ❌ | `2500` | Milliseconds between role API calls. `2500` = safe for any server size |
| `BATCH_SIZE` | ❌ | `10` | Members processed per event-loop tick |
| `MAX_RETRIES` | ❌ | `3` | Retry attempts for failed role assignments |
| `LOG_LEVEL` | ❌ | `info` | Console log verbosity: `error` \| `warn` \| `info` \| `debug` |
| `WEBHOOK_URL` | ❌ | — | Discord webhook URL for external log delivery |
| `NODE_ENV` | ❌ | `production` | Node environment |

---

## 📖 Usage Guide

### Migrating roles

```
/migrate-role
  source_role: @VIP+
  target_role: @Alpha
  remove_old_role: False     ← keep VIP+ after assigning Alpha
  include_bots: False
  dry_run: False
```

The bot will:
1. Validate permissions and role hierarchy
2. Show a confirmation embed with member count and ETA
3. Ask you to confirm with a button
4. Run the migration with live progress updates

### Dry Run (preview before committing)

Set `dry_run: True` to see exactly who would be migrated **without touching any roles**. Use this first on large servers to verify your settings.

### Listing role members

```
/list-role-members
  role: @VIP+
  post_to_channel: #vip-members    ← optional: post to a specific channel
  include_bots: False
```

Posts all members with the role as clickable mentions. Each role can be posted to a different channel.

### Rate limit tuning

For large servers (1000+ members needing migration), the default `RATE_LIMIT_DELAY=2500` is recommended. For smaller servers or faster migrations, you can lower it:

| Delay | Speed | Rate limit risk |
|---|---|---|
| `2500ms` | ~1 req/2.5s | ✅ None |
| `1200ms` | ~1 req/1.2s | ⚠️ Occasional |
| `500ms` | ~2 req/s | ❌ Frequent |

Discord.js automatically handles rate limit responses (waits and retries), so even at lower values the migration will complete — just with more warnings.

---

## 📁 Project Structure

```
discord-role-migration/
├── commands/
│   ├── migrateRole.js          # /migrate-role
│   ├── migrationStatus.js      # /migration-status
│   ├── cancelMigration.js      # /cancel-migration
│   ├── migrationHistory.js     # /migration-history
│   ├── exportMigration.js      # /export-migration
│   ├── setLogChannel.js        # /set-log-channel
│   └── listRoleMembers.js      # /list-role-members
├── config/
│   └── config.js               # Centralised config with env validation
├── database/
│   └── database.js             # SQLite DAO (uses built-in node:sqlite)
├── events/
│   ├── ready.js                # Bot ready handler
│   └── interactionCreate.js    # Command dispatch
├── services/
│   └── migrationService.js     # Core migration engine
├── utils/
│   ├── embeds.js               # Embed builders and colour palette
│   ├── helpers.js              # Rate-limit queue, retry logic, validators
│   └── logger.js               # Winston logger with daily rotation
├── deploy-commands.js          # Slash command registration script
├── index.js                    # Bot entry point
├── .env.example                # Environment variable template
└── package.json
```

---

## 🗄️ Database

The bot uses **Node.js's built-in `node:sqlite`** module (available since Node.js v22.5.0) — no native compilation or external SQLite packages required.

The database is created automatically at `./database/migrations.db` on first run and contains:

- **`migration_jobs`** — One record per migration run (status, counts, timestamps)
- **`migration_member_logs`** — One record per member processed (result, reason)
- **`bot_config`** — Per-guild configuration (log channel ID, etc.)

---

## 🔒 Permissions Required

| Permission | Why |
|---|---|
| `Manage Roles` | To assign and remove roles from members |
| `Send Messages` | To post migration reports and progress embeds |
| `Embed Links` | To send rich embeds |
| `Read Message History` | To read channel history for button interactions |

> The bot enforces a **role hierarchy check** before every migration. If the bot's highest role is not above the target role, the migration is blocked with a clear error message.

---

## 🛡️ Safety Features

- **Admin-only commands** — All commands require `Administrator` permission
- **Confirmation button** — Migration requires explicit confirmation before starting
- **Hierarchy validation** — Bot checks it can actually assign the target role
- **Pre-flight validation** — Source and target role are validated before any API calls
- **Graceful cancellation** — Cancel leaves the database in a consistent state
- **Crash-resilient** — Rate limit errors and WebSocket disconnects do not crash the bot
- **Existing members protected** — Members who already have the target role are skipped, not modified

---

## 📜 License

MIT — free to use, modify, and distribute. See [LICENSE](LICENSE) for details.

---

## 🤝 Contributing

Pull requests are welcome! Please open an issue first to discuss major changes.

1. Fork the repository
2. Create your feature branch: `git checkout -b feature/my-feature`
3. Commit your changes: `git commit -m 'Add my feature'`
4. Push to the branch: `git push origin feature/my-feature`
5. Open a Pull Request

---

<div align="center">
Made with ❤️ for Discord server admins everywhere
</div>
