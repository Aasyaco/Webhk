'use strict';

const { loadConfig }     = require('../lib/config');
const { verifySignature } = require('../lib/webhook');
const { makeGitHubHelper } = require('../lib/github');
const { logger }           = require('../lib/logger');
const {
  handleBackportPR,
  handleCIStatusChange,
  handlePRReview,
  handlePRLabeled,
} = require('../lib/handlers');

/**
 * Vercel Serverless Function: POST /api/webhook
 *
 * Receives GitHub webhook events and dispatches to the appropriate handler.
 * Vercel functions must complete within maxDuration (60s) — we respond 200
 * immediately and await the handler. For long backports the handler runs
 * within the same function invocation.
 */
module.exports = async function handler(req, res) {
  // ── CORS preflight ────────────────────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error('Config error:', err.message);
    return res.status(500).json({ error: 'Server configuration error', detail: err.message });
  }

  // ── Read raw body ─────────────────────────────────────────────────────────
  // Vercel provides req.body as already-parsed if Content-Type is JSON.
  // We need the raw buffer for HMAC. Use a small trick:
  const rawBody = await _getRawBody(req);

  // ── Verify signature ──────────────────────────────────────────────────────
  try {
    verifySignature(config.webhookSecret, rawBody, req.headers['x-hub-signature-256']);
  } catch (err) {
    logger.warn('Webhook signature failure', { ip: req.headers['x-forwarded-for'] });
    return res.status(err.status ?? 401).json({ error: err.message });
  }

  // ── Parse payload ─────────────────────────────────────────────────────────
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const eventType  = req.headers['x-github-event'] ?? 'unknown';
  const deliveryId = req.headers['x-github-delivery'] ?? '-';
  logger.info(`Webhook received: ${eventType}`, { delivery: deliveryId });

  // ── Respond immediately (GitHub requires <10s acknowledgement) ────────────
  res.status(200).json({ ok: true, event: eventType, delivery: deliveryId });

  // ── Dispatch ──────────────────────────────────────────────────────────────
  try {
    const gh = makeGitHubHelper(config);
    await dispatch(eventType, payload, gh, config);
  } catch (err) {
    logger.error(`Handler error [${eventType}]`, { error: err.message, stack: err.stack });
  }
};

// ─────────────────────────────────────────────────────────────────────────────

async function dispatch(eventType, payload, gh, config) {
  switch (eventType) {

    case 'pull_request': {
      const { action, pull_request: pr, label } = payload;

      if (action === 'closed' && pr?.merged) {
        await handleBackportPR(payload, gh, config);
      }
      if (action === 'labeled') {
        await handleBackportPR(payload, gh, config);
        await handlePRLabeled(payload, gh, config);
      }
      break;
    }

    case 'pull_request_review':
      if (payload.action === 'submitted') {
        await handlePRReview(payload, gh, config);
      }
      break;

    case 'status':
      if (payload.sha) await handleCIStatusChange(payload.sha, gh, config);
      break;

    case 'check_run':
      if (payload.action === 'completed' && payload.check_run?.head_sha) {
        await handleCIStatusChange(payload.check_run.head_sha, gh, config);
      }
      break;

    case 'check_suite':
      if (payload.action === 'completed' && payload.check_suite?.head_sha) {
        await handleCIStatusChange(payload.check_suite.head_sha, gh, config);
      }
      break;

    case 'installation':
    case 'installation_repositories':
      logger.info(`GitHub App installation event: ${payload.action}`, {
        account: payload.installation?.account?.login,
      });
      break;

    default:
      logger.debug(`Ignored event: ${eventType}`);
  }
}

// ── Raw body helper ────────────────────────────────────────────────────────────

async function _getRawBody(req) {
  // Vercel may have already buffered the body
  if (req.body instanceof Buffer) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8');
  if (req.body && typeof req.body === 'object') {
    // Already parsed JSON object — re-serialize deterministically
    return Buffer.from(JSON.stringify(req.body), 'utf8');
  }

  // Stream it manually
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
