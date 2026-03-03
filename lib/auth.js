'use strict';

/**
 * Dual-mode GitHub authentication.
 *
 * GitHub App mode:
 *   - Signs RS256 JWTs to exchange for installation access tokens
 *   - Installation tokens auto-refresh (1-hour TTL, cached with 5-min buffer)
 *   - Used for all API calls + git push (x-access-token)
 *
 * PAT mode:
 *   - Uses GITHUB_TOKEN directly for both API and git push
 */

const crypto = require('crypto');

// In-memory token cache — survives within a single serverless invocation.
// Vercel functions can share memory within the same instance for warm starts.
const _cache = new Map(); // key → { token, expiresAt }

/**
 * Returns a valid Bearer/token string for GitHub API calls.
 * @param {object} config – from loadConfig()
 * @returns {Promise<string>}  e.g. "token ghp_xxx" or "Bearer eyJ..."
 */
async function getApiAuth(config) {
  if (config.authMode === 'token') {
    return `token ${config.githubToken}`;
  }

  // GitHub App: get installation token
  const cacheKey = `installation:${config.installationId}`;
  const cached   = _cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 5 * 60_000) {
    return `token ${cached.token}`;
  }

  const jwt   = _makeJWT(config.appId, config.appPrivateKey);
  const token = await _exchangeJWT(jwt, config.installationId);
  _cache.set(cacheKey, { token: token.value, expiresAt: token.expiresAt });
  return `token ${token.value}`;
}

/**
 * Returns the credential string to embed in a git remote URL.
 * Format: "x-access-token:<token>"  (works for both PAT and installation tokens)
 */
async function getGitCredential(config) {
  if (config.authMode === 'token') {
    return `x-access-token:${config.githubToken}`;
  }
  const auth  = await getApiAuth(config);
  const token = auth.replace(/^token /, '');
  return `x-access-token:${token}`;
}

/**
 * Returns the actor name used for git commits / PR author.
 * GitHub App: uses the App's slug + [bot] suffix.
 * PAT: uses the BOT_USERNAME config value.
 */
function getBotActor(config) {
  if (config.authMode === 'app') {
    return `${config.botUsername}[bot]`;
  }
  return config.botUsername;
}

/**
 * Returns the noreply email for git commits.
 */
function getBotEmail(config) {
  if (config.authMode === 'app') {
    return `${config.installationId}+${config.botUsername}[bot]@users.noreply.github.com`;
  }
  return `${config.botUsername}@users.noreply.github.com`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function _makeJWT(appId, privateKey) {
  const now     = Math.floor(Date.now() / 1000);
  const header  = _b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = _b64url(JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }));
  const input   = `${header}.${payload}`;
  const sig     = crypto.createSign('RSA-SHA256').update(input).sign(privateKey, 'base64url');
  return `${input}.${sig}`;
}

async function _exchangeJWT(jwt, installationId) {
  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization:          `Bearer ${jwt}`,
        Accept:                 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent':           'AxotBot/3.0',
      },
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => res.status);
    throw new Error(`GitHub App token exchange failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  return {
    value:     data.token,
    expiresAt: new Date(data.expires_at).getTime(),
  };
}

function _b64url(str) {
  return Buffer.from(str).toString('base64url');
}

module.exports = { getApiAuth, getGitCredential, getBotActor, getBotEmail };
