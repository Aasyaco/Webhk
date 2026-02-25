// api/webhook.js
const crypto = require('node:crypto');

const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const VERCEL_DEPLOY_HOOK_URL = process.env.VERCEL_DEPLOY_HOOK_URL;

if (!GITHUB_WEBHOOK_SECRET) {
  console.error('Missing GITHUB_WEBHOOK_SECRET');
  process.exit(1);
}

if (!VERCEL_DEPLOY_HOOK_URL) {
  console.error('Missing VERCEL_DEPLOY_HOOK_URL');
  process.exit(1);
}

function verifySignature(payload, signature) {
  if (typeof signature !== 'string' || !signature.startsWith('sha256=')) {
    return false;
  }

  const hmac = crypto.createHmac('sha256', GITHUB_WEBHOOK_SECRET);
  const digest = 'sha256=' + hmac.update(payload).digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(digest),
    Buffer.from(signature)
  );
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }

  // Important: Vercel provides rawBody in dev & prod when using Node.js runtime
  const rawBody = req.bodyRaw || Buffer.from(JSON.stringify(req.body));

  const signature = req.headers['x-hub-signature-256'];
  const event = req.headers['x-github-event'];

  if (!verifySignature(rawBody, signature)) {
    console.warn('Invalid signature');
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Invalid signature' }));
    return;
  }

  // For debugging
  console.log('Event received:', event);

  // Basic response – you can expand logic here
  try {
    // Example: trigger Vercel hook
    const deployResponse = await fetch(VERCEL_DEPLOY_HOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ triggered_by: 'webhook', event })
    });

    if (!deployResponse.ok) {
      throw new Error(`Deploy hook failed: ${deployResponse.status}`);
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'deployment_triggered' }));
  } catch (err) {
    console.error(err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Internal error' }));
  }
};
