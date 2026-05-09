'use strict';
const { Events, ActivityType } = require('discord.js');
const logger = require('../utils/logger');

/**
 * ready — Fires once the bot is logged in and ready to receive events.
 */
module.exports = {
  name: Events.ClientReady,
  once: true, // Only fires once at startup

  /**
   * @param {import('discord.js').Client} client
   */
  execute(client) {
    logger.info(`[Bot] Logged in as ${client.user.tag} (${client.user.id})`);
    logger.info(`[Bot] Serving ${client.guilds.cache.size} guild(s)`);

    // Set bot presence/activity
    client.user.setPresence({
      activities: [{
        name: 'Role Migrations',
        type: ActivityType.Watching,
      }],
      status: 'online',
    });

    logger.info('[Bot] ✅ Bot is ready and accepting commands.');
  },
};
