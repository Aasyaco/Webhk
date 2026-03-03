'use strict';

const { loadConfig } = require('../lib/config');
const { getSnapshot } = require('../lib/state');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();

  let config;
  try { config = loadConfig(); } catch { config = null; }

  const snap   = await getSnapshot(config);
  const limit  = parseInt(req.query?.limit ?? '50', 10);

  return res.status(200).json({
    recentBackports: (snap.recentBackports ?? []).slice(0, limit),
    recentMerges:    (snap.recentMerges    ?? []).slice(0, limit),
  });
};
