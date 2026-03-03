'use strict';

/**
 * AxotBot configuration loader.
 *
 * Supports TWO authentication modes — determined automatically from env vars:
 *
 *   MODE A: GitHub App  (recommended for production)
 *     Required: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID
 *     Optional: GITHUB_TOKEN (used as fallback for git push if needed)
 *
 *   MODE B: Personal Access Token  (simpler for personal use)
 *     Required: GITHUB_TOKEN
 *
 * In both modes the following are always required:
 *   GITHUB_SECRET  – webhook HMAC secret
 */

const DEFAULTS = {
  BOT_USERNAME:           'AxotBot',
  UPSTREAM_OWNER:         'zrsx',
  UPSTREAM_REPO:          'cpython',
  MERGE_METHOD:           'squash',
  AUTOMERGE_LABEL:        '🤖 automerge',
  BACKPORT_LABEL_PREFIX:  'needs backport to',
  AWAITING_MERGE_LABEL:   'awaiting merge',
  BACKPORT_SUCCESS_LABEL: 'backport-done',
  CI_SETTLE_MS:           '8000',
  MAX_COMMITS_FOR_AUTOMERGE: '1',
  LOG_LEVEL:              'info',
};

function loadConfig() {
  const e = (k) => process.env[k] ?? DEFAULTS[k];

  // ── Required in all modes ─────────────────────────────────────────────────
  _require('GITHUB_SECRET');

  // ── Determine auth mode ───────────────────────────────────────────────────
  const hasAppCreds = !!(
    process.env.GITHUB_APP_ID &&
    process.env.GITHUB_APP_PRIVATE_KEY &&
    process.env.GITHUB_APP_INSTALLATION_ID
  );
  const hasToken = !!process.env.GITHUB_TOKEN;

  if (!hasAppCreds && !hasToken) {
    throw new Error(
      'AxotBot: no GitHub credentials found.\n\n' +
      'Set ONE of:\n' +
      '  GitHub App:  GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY + GITHUB_APP_INSTALLATION_ID\n' +
      '  PAT:         GITHUB_TOKEN\n\n' +
      'See .env.example for details.'
    );
  }

  const authMode = hasAppCreds ? 'app' : 'token';

  // ── Decode PEM (Vercel stores env vars base64 or raw) ─────────────────────
  let privateKey = null;
  if (hasAppCreds) {
    const raw = process.env.GITHUB_APP_PRIVATE_KEY;
    // If it looks like base64 (no newlines, long string), decode it
    privateKey = raw.includes('-----') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    // Normalize line endings (some env providers strip newlines)
    if (!privateKey.includes('\n')) {
      privateKey = privateKey
        .replace('-----BEGIN RSA PRIVATE KEY-----', '-----BEGIN RSA PRIVATE KEY-----\n')
        .replace('-----END RSA PRIVATE KEY-----',   '\n-----END RSA PRIVATE KEY-----')
        .replace(/(.{64})/g, '$1\n');
    }
  }

  return {
    // ── Auth ──────────────────────────────────────────────────────────────
    authMode,
    githubToken:      process.env.GITHUB_TOKEN ?? null,
    appId:            process.env.GITHUB_APP_ID ?? null,
    appPrivateKey:    privateKey,
    installationId:   process.env.GITHUB_APP_INSTALLATION_ID ?? null,

    // ── Webhook ───────────────────────────────────────────────────────────
    webhookSecret:    process.env.GITHUB_SECRET,

    // ── Repo ──────────────────────────────────────────────────────────────
    botUsername:      e('BOT_USERNAME'),
    upstreamOwner:    e('UPSTREAM_OWNER'),
    upstreamRepo:     e('UPSTREAM_REPO'),
    repoPath:         `${e('UPSTREAM_OWNER')}/${e('UPSTREAM_REPO')}`,

    // ── Behaviour ─────────────────────────────────────────────────────────
    mergeMethod:         e('MERGE_METHOD'),
    automergeLabel:      e('AUTOMERGE_LABEL'),
    backportLabelPrefix: e('BACKPORT_LABEL_PREFIX'),
    awaitingMergeLabel:  e('AWAITING_MERGE_LABEL'),
    backportSuccessLabel:e('BACKPORT_SUCCESS_LABEL'),
    ciSettleMs:          parseInt(e('CI_SETTLE_MS'), 10),
    maxCommitsForAutomerge: parseInt(e('MAX_COMMITS_FOR_AUTOMERGE'), 10),
    logLevel:            e('LOG_LEVEL'),

    // ── Vercel KV (optional – for persisted stats) ────────────────────────
    kvUrl:            process.env.KV_REST_API_URL  ?? null,
    kvToken:          process.env.KV_REST_API_TOKEN ?? null,
  };
}

function _require(key) {
  if (!process.env[key]) {
    throw new Error(`AxotBot: missing required environment variable: ${key}`);
  }
}

/** Human-readable summary of the current auth mode (for logs/health endpoint). */
function describeAuth(config) {
  if (config.authMode === 'app') {
    return `GitHub App (id=${config.appId}, installation=${config.installationId})`;
  }
  return `Personal Access Token (user token)`;
}

module.exports = { loadConfig, describeAuth };
