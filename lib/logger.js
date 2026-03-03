'use strict';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function makeLogger(level = 'info') {
  const threshold = LEVELS[level] ?? 1;

  function log(lvl, msg, meta = {}) {
    if ((LEVELS[lvl] ?? 0) < threshold) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...meta });
    lvl === 'error' ? console.error(line) : console.log(line);
  }

  return {
    debug: (m, d) => log('debug', m, d),
    info:  (m, d) => log('info',  m, d),
    warn:  (m, d) => log('warn',  m, d),
    error: (m, d) => log('error', m, d),
  };
}

// Default singleton
const logger = makeLogger(process.env.LOG_LEVEL || 'info');

module.exports = { logger, makeLogger };
