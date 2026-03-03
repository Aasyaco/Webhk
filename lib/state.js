'use strict';

/**
 * State persistence layer.
 *
 * Tries to use Vercel KV (REST API) when KV_REST_API_URL + KV_REST_API_TOKEN
 * are set. Falls back to in-memory if not configured or on error.
 *
 * Vercel KV REST API: https://vercel.com/docs/storage/vercel-kv/rest-api
 */

const _mem = {
  startedAt:           new Date().toISOString(),
  backportsAttempted:  0,
  backportsSucceeded:  0,
  backportsFailed:     0,
  mergesCompleted:     0,
  recentBackports:     [],
  recentMerges:        [],
};

const KV_KEY = 'axotbot:stats';
const MAX    = 50;

// ── KV helpers ────────────────────────────────────────────────────────────────

async function _kvGet(config) {
  if (!config?.kvUrl || !config?.kvToken) return null;
  try {
    const res = await fetch(`${config.kvUrl}/get/${KV_KEY}`, {
      headers: { Authorization: `Bearer ${config.kvToken}` },
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.result ? JSON.parse(json.result) : null;
  } catch { return null; }
}

async function _kvSet(config, data) {
  if (!config?.kvUrl || !config?.kvToken) return;
  try {
    await fetch(`${config.kvUrl}/set/${KV_KEY}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.kvToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ value: JSON.stringify(data) }),
    });
  } catch { /* silent — fallback to memory */ }
}

// ── Public API ────────────────────────────────────────────────────────────────

async function getSnapshot(config) {
  const kv = await _kvGet(config);
  const s  = kv ?? _mem;
  return {
    ...s,
    uptime:       _msToHuman(Date.now() - new Date(s.startedAt).getTime()),
    recentBackports: (s.recentBackports ?? []).slice(0, 30),
    recentMerges:    (s.recentMerges    ?? []).slice(0, 30),
    authMode:     config?.authMode ?? 'unknown',
    repoPath:     config?.repoPath ?? 'zrsx/cpython',
    botUsername:  config?.botUsername ?? 'AxotBot',
  };
}

async function recordBackportAttempt(config, { prNumber, branch }) {
  const s = await _load(config);
  s.backportsAttempted++;
  _prepend(s.recentBackports, { prNumber, branch, status: 'pending', ts: new Date().toISOString() });
  await _save(config, s);
}

async function recordBackportSuccess(config, { prNumber, branch, newPrNumber, prUrl }) {
  const s = await _load(config);
  s.backportsSucceeded++;
  _update(s.recentBackports, { prNumber, branch }, { status: 'success', newPrNumber, prUrl, ts: new Date().toISOString() });
  await _save(config, s);
}

async function recordBackportFailure(config, { prNumber, branch, error }) {
  const s = await _load(config);
  s.backportsFailed++;
  _update(s.recentBackports, { prNumber, branch }, { status: 'failed', error, ts: new Date().toISOString() });
  await _save(config, s);
}

async function recordMerge(config, { prNumber, title }) {
  const s = await _load(config);
  s.mergesCompleted++;
  _prepend(s.recentMerges, { prNumber, title, ts: new Date().toISOString() });
  await _save(config, s);
}

// ── Internal ──────────────────────────────────────────────────────────────────

async function _load(config) {
  return (await _kvGet(config)) ?? { ..._mem };
}

async function _save(config, data) {
  // Update in-memory always
  Object.assign(_mem, data);
  // Persist to KV if available
  await _kvSet(config, data);
}

function _prepend(arr, item) {
  arr.unshift(item);
  if (arr.length > MAX) arr.length = MAX;
}

function _update(arr, match, patch) {
  const i = arr.findIndex(x => x.prNumber === match.prNumber && x.branch === match.branch);
  if (i >= 0) arr[i] = { ...arr[i], ...patch };
  else _prepend(arr, { ...match, ...patch });
}

function _msToHuman(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

module.exports = { getSnapshot, recordBackportAttempt, recordBackportSuccess, recordBackportFailure, recordMerge };
