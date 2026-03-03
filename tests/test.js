'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

// ── Webhook signature ─────────────────────────────────────────────────────────
describe('verifySignature', () => {
  const { verifySignature } = require('../lib/webhook');

  test('accepts valid sha256 signature', () => {
    const secret = 'axotbot-webhook-secret';
    const body   = Buffer.from('{"action":"labeled","label":{"name":"needs backport to 3.12"}}');
    const sig    = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
    assert.doesNotThrow(() => verifySignature(secret, body, sig));
  });

  test('rejects signature for different body', () => {
    const secret = 'axotbot-webhook-secret';
    const body   = Buffer.from('{"action":"opened"}');
    const sig    = `sha256=${crypto.createHmac('sha256', secret).update(Buffer.from('tampered')).digest('hex')}`;
    assert.throws(() => verifySignature(secret, body, sig), { status: 401 });
  });

  test('rejects missing header → 400', () => {
    assert.throws(
      () => require('../lib/webhook').verifySignature('secret', Buffer.from('x'), undefined),
      { status: 400 }
    );
  });

  test('rejects wrong-length signature without RangeError', () => {
    assert.throws(
      () => require('../lib/webhook').verifySignature('secret', Buffer.from('body'), 'sha256=tooshort'),
      err => err.status === 401
    );
  });
});

// ── Branch sorting ────────────────────────────────────────────────────────────
describe('sortBranchesDesc', () => {
  const { sortBranchesDesc } = require('../lib/github');

  test('sorts CPython branches newest first', () => {
    assert.deepEqual(
      sortBranchesDesc(['3.11', '3.13', '2.7', '3.12', '3.14']),
      ['3.14', '3.13', '3.12', '3.11', '2.7']
    );
  });

  test('handles single item', () => {
    assert.deepEqual(sortBranchesDesc(['3.12']), ['3.12']);
  });

  test('is non-mutating', () => {
    const orig = ['3.11', '3.13'];
    sortBranchesDesc(orig);
    assert.deepEqual(orig, ['3.11', '3.13']);
  });
});

// ── Auth module ───────────────────────────────────────────────────────────────
describe('getApiAuth', () => {
  const { getApiAuth } = require('../lib/auth');

  test('PAT mode returns token header', async () => {
    const config = { authMode: 'token', githubToken: 'ghp_test123' };
    assert.equal(await getApiAuth(config), 'token ghp_test123');
  });

  test('App mode attempts token exchange (mocked)', async () => {
    // We can't test the real exchange without credentials, but we can verify
    // the code path exits auth mode check correctly
    const config = { authMode: 'app', appId: '999', appPrivateKey: null, installationId: '123' };
    // Private key is null so it will throw — confirm it's an auth error, not config error
    await assert.rejects(() => getApiAuth(config), /sign|key|PEM|private/i);
  });
});

// ── Config defaults ───────────────────────────────────────────────────────────
describe('loadConfig', () => {
  function withEnv(overrides, fn) {
    const saved = {};
    for (const [k, v] of Object.entries(overrides)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try { return fn(); }
    finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  function freshConfig() {
    delete require.cache[require.resolve('../lib/config')];
    return require('../lib/config');
  }

  test('uses zrsx/cpython defaults', () => {
    const cfg = withEnv(
      { GITHUB_TOKEN: 'tok', GITHUB_SECRET: 'sec', UPSTREAM_OWNER: undefined, UPSTREAM_REPO: undefined, BOT_USERNAME: undefined },
      () => freshConfig().loadConfig()
    );
    assert.equal(cfg.upstreamOwner, 'zrsx');
    assert.equal(cfg.upstreamRepo,  'cpython');
    assert.equal(cfg.botUsername,   'AxotBot');
    assert.equal(cfg.repoPath,      'zrsx/cpython');
    assert.equal(cfg.authMode,      'token');
  });

  test('prefers App mode when App creds present', () => {
    const cfg = withEnv(
      {
        GITHUB_TOKEN: 'tok',
        GITHUB_SECRET: 'sec',
        GITHUB_APP_ID: '123',
        GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----',
        GITHUB_APP_INSTALLATION_ID: '456',
      },
      () => freshConfig().loadConfig()
    );
    assert.equal(cfg.authMode, 'app');
    assert.equal(cfg.appId,    '123');
    assert.equal(cfg.installationId, '456');
  });

  test('throws when neither token nor app creds present', () => {
    assert.throws(
      () => withEnv(
        { GITHUB_TOKEN: undefined, GITHUB_APP_ID: undefined, GITHUB_APP_PRIVATE_KEY: undefined, GITHUB_APP_INSTALLATION_ID: undefined, GITHUB_SECRET: 'sec' },
        () => freshConfig().loadConfig()
      ),
      /credentials/i
    );
  });

  test('throws when GITHUB_SECRET is missing', () => {
    assert.throws(
      () => withEnv(
        { GITHUB_TOKEN: 'tok', GITHUB_SECRET: undefined },
        () => freshConfig().loadConfig()
      ),
      /GITHUB_SECRET/
    );
  });

  test('describeAuth returns human-readable string', () => {
    const { loadConfig, describeAuth } = freshConfig();
    const cfg = withEnv({ GITHUB_TOKEN: 'tok', GITHUB_SECRET: 'sec' }, () => loadConfig());
    const desc = describeAuth(cfg);
    assert.ok(typeof desc === 'string' && desc.length > 0);
    assert.ok(desc.includes('token') || desc.includes('App'));
  });
});

// ── allCIGreen ────────────────────────────────────────────────────────────────
describe('GitHubHelper.allCIGreen', () => {
  const { GitHubAPI, GitHubHelper } = require('../lib/github');

  function mkGH(state, runs = []) {
    const api  = new GitHubAPI({ authMode: 'token', githubToken: 'x', upstreamOwner: 'zrsx', upstreamRepo: 'cpython' });
    api.request = async (_, url) => {
      if (url.includes('/status'))     return { state };
      if (url.includes('/check-runs')) return { check_runs: runs };
    };
    return new GitHubHelper(api, { owner: 'zrsx', repo: 'cpython' });
  }

  test('false when status pending', async () => assert.equal(await mkGH('pending').allCIGreen('sha'), false));
  test('false when status failure', async () => assert.equal(await mkGH('failure').allCIGreen('sha'), false));
  test('false when check_run in_progress', async () => assert.equal(
    await mkGH('success', [{ status: 'in_progress', conclusion: null }]).allCIGreen('sha'), false
  ));
  test('false when check_run failed', async () => assert.equal(
    await mkGH('success', [{ status: 'completed', conclusion: 'failure' }]).allCIGreen('sha'), false
  ));
  test('true when success + all checks passed', async () => assert.equal(
    await mkGH('success', [
      { status: 'completed', conclusion: 'success' },
      { status: 'completed', conclusion: 'skipped' },
    ]).allCIGreen('sha'), true
  ));
  test('true when success + no check runs', async () => assert.equal(
    await mkGH('success', []).allCIGreen('sha'), true
  ));
});

// ── State module ──────────────────────────────────────────────────────────────
describe('state', () => {
  const state = require('../lib/state');
  const cfg   = null; // null config = in-memory only (no KV)

  test('records backport attempt', async () => {
    await state.recordBackportAttempt(cfg, { prNumber: 1001, branch: '3.12' });
    const snap = await state.getSnapshot(cfg);
    assert.ok(snap.backportsAttempted >= 1);
    assert.ok(snap.recentBackports.some(b => b.prNumber === 1001 && b.branch === '3.12'));
  });

  test('updates to success', async () => {
    await state.recordBackportSuccess(cfg, { prNumber: 1001, branch: '3.12', newPrNumber: 2002, prUrl: 'https://example.com' });
    const snap = await state.getSnapshot(cfg);
    assert.ok(snap.backportsSucceeded >= 1);
    const entry = snap.recentBackports.find(b => b.prNumber === 1001 && b.branch === '3.12');
    assert.equal(entry?.status, 'success');
    assert.equal(entry?.newPrNumber, 2002);
  });

  test('records failure', async () => {
    await state.recordBackportFailure(cfg, { prNumber: 1002, branch: '3.11', error: 'conflict' });
    const snap = await state.getSnapshot(cfg);
    assert.ok(snap.backportsFailed >= 1);
  });

  test('records merge', async () => {
    await state.recordMerge(cfg, { prNumber: 500, title: 'GH-500: Fix memory leak' });
    const snap = await state.getSnapshot(cfg);
    assert.ok(snap.mergesCompleted >= 1);
    assert.ok(snap.recentMerges.some(m => m.prNumber === 500));
  });

  test('snapshot has string uptime', async () => {
    const snap = await state.getSnapshot(cfg);
    assert.ok(typeof snap.uptime === 'string' && snap.uptime.length > 0);
  });
});
