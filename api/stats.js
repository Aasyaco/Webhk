'use strict';

const { loadConfig, describeAuth } = require('../lib/config');
const { getSnapshot }              = require('../lib/state');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();

  let config;
  try { config = loadConfig(); }
  catch (err) {
    return res.status(500).json({
      error:        'Configuration error',
      detail:       err.message,
      // Provide safe defaults so the dashboard still renders
      backportsAttempted: 0,
      backportsSucceeded: 0,
      backportsFailed:    0,
      mergesCompleted:    0,
      recentBackports:    [],
      recentMerges:       [],
      uptime:             '—',
      authMode:           'unknown',
      repoPath:           'zrsx/cpython',
      botUsername:        'AxotBot',
    });
  }

  const snap = await getSnapshot(config);
  return res.status(200).json({
    ...snap,
    authDescription: describeAuth(config),
    version:         '3.0.0',
  });
};
