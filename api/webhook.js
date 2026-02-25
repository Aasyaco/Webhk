// api/webhook.js
const crypto = require('node:crypto');

const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const VERCEL_DEPLOY_HOOK_URL = process.env.VERCEL_DEPLOY_HOOK_URL;

if (!GITHUB_WEBHOOK_SECRET) {
  console.error('Missing GITHUB_WEBHOOK_SECRET environment variable');
  process.exit(1);
}

if (!VERCEL_DEPLOY_HOOK_URL) {
  console.error('Missing VERCEL_DEPLOY_HOOK_URL environment variable');
  process.exit(1);
}

/**
 * Securely compare two strings in constant time
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqualString(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verify GitHub webhook signature (sha256)
 * @param {Buffer|string} payload Raw body
 * @param {string} signatureHeader X-Hub-Signature-256 header
 * @returns {boolean}
 */
function verifyGitHubSignature(payload, signatureHeader) {
  if (typeof signatureHeader !== 'string' || !signatureHeader.startsWith('sha256=')) {
    return false;
  }

  const expected = 'sha256=' + crypto
    .createHmac('sha256', GITHUB_WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');

  return timingSafeEqualString(expected, signatureHeader);
}

module.exports = async (req, res) => {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Vercel already parses JSON when Content-Type is application/json
  const payload = req.body;
  const rawBody = req.bodyRaw || JSON.stringify(payload); // fallback if bodyRaw not available

  const signature = req.headers['x-hub-signature-256'];
  const event = req.headers['x-github-event'];
  const delivery = req.headers['x-github-delivery'] || 'unknown';

  // 1. Signature validation (critical security step)
  if (!verifyGitHubSignature(rawBody, signature)) {
    console.warn(`Invalid signature — delivery: ${delivery}`);
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // 2. Optional: filter relevant events only
  const allowedEvents = ['push', 'pull_request'];
  if (!allowedEvents.includes(event)) {
    return res.status(200).json({ status: 'ignored', event });
  }

  // 3. Optional: add more business logic here
  //    e.g. only trigger on main branch pushes or when PR is opened/synchronized/merged
  const branch = payload.ref?.replace(/^refs\/heads\//, '');
  const action = payload.action;

  const shouldDeploy =
    event === 'push' && branch === 'main' ||
    (event === 'pull_request' && ['opened', 'synchronize', 'reopened'].includes(action));

  if (!shouldDeploy) {
    return res.status(200).json({ status: 'skipped', reason: 'conditions not met', branch, action });
  }

  // 4. Trigger Vercel Deploy Hook (fire and forget — no auth needed)
  try {
    const deployRes = await fetch(VERCEL_DEPLOY_HOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Optional: you can send payload data that Vercel ignores but you might log
      body: JSON.stringify({ github_event: event, delivery })
    });

    if (!deployRes.ok) {
      const text = await deployRes.text();
      console.error(`Vercel hook failed: ${deployRes.status} — ${text}`);
      return res.status(502).json({ error: 'Failed to trigger Vercel deployment' });
    }

    console.info(`Vercel deployment triggered — delivery: ${delivery} — event: ${event}`);
    return res.status(200).json({ status: 'deployment_triggered', delivery });
  } catch (err) {
    console.error('Error triggering Vercel deploy hook', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
