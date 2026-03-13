/**
 * src/utils/logger.js — Structured logging dengan Winston
 */
const winston = require('winston');
const path = require('path');

const { combine, timestamp, printf, colorize, errors, json } = winston.format;

const consoleFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `${timestamp} [${level}] ${stack || message}${metaStr}`;
  })
);

const fileFormat = combine(
  timestamp(),
  errors({ stack: true }),
  json()
);

const transports = [
  new winston.transports.Console({ format: consoleFormat }),
];

// File logging hanya jika LOG_FILE di-set
if (process.env.LOG_FILE) {
  const logDir = path.dirname(process.env.LOG_FILE);
  const fs = require('fs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

  transports.push(
    new winston.transports.File({
      filename: process.env.LOG_FILE,
      format: fileFormat,
      maxsize: 10 * 1024 * 1024, // 10 MB
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: process.env.LOG_FILE.replace('.log', '.error.log'),
      level: 'error',
      format: fileFormat,
    })
  );
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  transports,
  exitOnError: false,
});

// Morgan stream integration
logger.stream = {
  write: (message) => logger.http(message.trim()),
};

module.exports = logger;
