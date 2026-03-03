'use strict';

const { loadConfig, describeAuth } = require('../lib/config');

module.exports = async function handler(req, res) {
  let status = 'ok';
  let detail = {};
  let code   = 200;

  try {
    const config = loadConfig();
    detail = {
      status:      'ok',
      bot:         config.botUsername,
      repo:        config.repoPath,
      authMode:    config.authMode,
      auth:        describeAuth(config),
      kvEnabled:   !!(config.kvUrl && config.kvToken),
      version:     '3.0.0',
      runtime:     'vercel-serverless',
      nodeVersion: process.version,
    };
  } catch (err) {
    status = 'error';
    code   = 503;
    detail = { status: 'error', error: err.message };
  }

  return res.status(code).json(detail);
};
