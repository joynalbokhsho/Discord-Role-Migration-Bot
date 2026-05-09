'use strict';
const { createLogger, format, transports } = require('winston');
require('winston-daily-rotate-file');
const config = require('../config/config');

// ── Formatting ──────────────────────────────────────────────────────────────

const { combine, timestamp, printf, colorize, errors } = format;

/** Human-readable console format */
const consoleFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length ? `\n${JSON.stringify(meta, null, 2)}` : '';
    return `[${timestamp}] ${level}: ${stack || message}${metaStr}`;
  })
);

/** JSON format for log files */
const fileFormat = combine(
  timestamp(),
  errors({ stack: true }),
  format.json()
);

// ── Transports ──────────────────────────────────────────────────────────────

const loggerTransports = [
  // Console transport
  new transports.Console({
    level: config.logging.level,
    format: consoleFormat,
  }),

  // Rotating file — all logs
  new transports.DailyRotateFile({
    filename: 'logs/combined-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxSize: '20m',
    maxFiles: '14d',
    level: 'debug',
    format: fileFormat,
  }),

  // Rotating file — errors only
  new transports.DailyRotateFile({
    filename: 'logs/error-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxSize: '20m',
    maxFiles: '30d',
    level: 'error',
    format: fileFormat,
  }),
];

// ── Logger instance ─────────────────────────────────────────────────────────

const logger = createLogger({
  level: 'debug',
  transports: loggerTransports,
  // Do not exit on unhandled promise rejections — handled in index.js
  exitOnError: false,
});

module.exports = logger;
