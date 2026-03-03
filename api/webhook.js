'use strict';

const crypto = require('crypto');

export const config = {
  api: {
    bodyParser: false
  }
};

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifySignature(secret, rawBody, signatureHeader) {
  if (!signatureHeader) {
    const e = new Error('Missing X-Hub-Signature-256 header');
    e.status = 400;
    throw e;
  }

  const expected = 'sha256=' +
    crypto.createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');

  const expectedBuf = Buffer.from(expected);
  const headerBuf = Buffer.from(signatureHeader);

  if (expectedBuf.length !== headerBuf.length ||
      !crypto.timingSafeEqual(expectedBuf, headerBuf)) {
    const e = new Error('Invalid webhook signature');
    e.status = 401;
    throw e;
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).end();
    }

    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
      return res.status(500).json({ error: 'Missing webhook secret' });
    }

    const rawBody = await getRawBody(req);
    const signature = req.headers['x-hub-signature-256'];

    verifySignature(secret, rawBody, signature);

    const event = req.headers['x-github-event'];
    const payload = JSON.parse(rawBody.toString('utf8'));

    return res.status(200).json({
      received: true,
      event
    });

  } catch (err) {
    return res.status(err.status || 500).json({
      error: err.message || 'Internal Server Error'
    });
  }
}
