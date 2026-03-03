'use strict';

const { getApiAuth } = require('./auth');

// ─────────────────────────────────────────────────────────────────────────────
// Core HTTP client — config-aware, dual-auth
// ─────────────────────────────────────────────────────────────────────────────

class GitHubAPI {
  constructor(config) {
    this.config    = config;
    this.baseUrl   = 'https://api.github.com';
    this.userAgent = `AxotBot/3.0 (${config.upstreamOwner}/${config.upstreamRepo})`;
  }

  async _headers() {
    const auth = await getApiAuth(this.config);
    return {
      Authorization:          auth,
      Accept:                 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent':           this.userAgent,
      'Content-Type':         'application/json',
    };
  }

  async request(method, url, body, { retries = 4 } = {}) {
    const fullUrl = url.startsWith('http') ? url : `${this.baseUrl}${url}`;
    const headers = await this._headers();
    const opts    = { method, headers };
    if (body !== undefined) opts.body = JSON.stringify(body);

    for (let attempt = 1; attempt <= retries; attempt++) {
      let res;
      try {
        res = await fetch(fullUrl, opts);
      } catch (netErr) {
        if (attempt < retries) { await _sleep(1500 * attempt); continue; }
        throw netErr;
      }

      // Primary rate limit
      if (res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) {
        const reset = res.headers.get('x-ratelimit-reset');
        const wait  = reset ? Math.max(2000, (parseInt(reset) * 1000) - Date.now() + 2000) : 30_000;
        if (attempt < retries) { await _sleep(wait); continue; }
      }

      // Secondary rate limit / abuse
      if (res.status === 403) {
        const retryAfter = parseInt(res.headers.get('retry-after') || '0') * 1000;
        if (retryAfter > 0 && attempt < retries) { await _sleep(retryAfter); continue; }
      }

      // No-content responses
      if (res.status === 204) return null;

      if (!res.ok) {
        const errBody = await res.text().catch(() => String(res.status));
        const err = new Error(`GitHub ${res.status} ${method} ${fullUrl}: ${errBody}`);
        err.status  = res.status;
        err.url     = fullUrl;
        err.ghBody  = errBody;
        throw err;
      }

      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }
  }

  get(url, opts)      { return this.request('GET',    url, undefined, opts); }
  post(url, b, opts)  { return this.request('POST',   url, b, opts); }
  patch(url, b, opts) { return this.request('PATCH',  url, b, opts); }
  put(url, b, opts)   { return this.request('PUT',    url, b, opts); }
  del(url, opts)      { return this.request('DELETE', url, undefined, opts); }
}

// ─────────────────────────────────────────────────────────────────────────────
// High-level helpers
// ─────────────────────────────────────────────────────────────────────────────

class GitHubHelper {
  constructor(api, { owner, repo }) {
    this.api   = api;
    this.owner = owner;
    this.repo  = repo;
  }

  _p(path) { return `/repos/${this.owner}/${this.repo}${path}`; }

  // Comments
  leaveComment(num, body)  { return this.api.post(this._p(`/issues/${num}/comments`), { body }); }

  // Labels
  addLabel(num, label)     { return this.api.post(this._p(`/issues/${num}/labels`), { labels: [label] }); }
  async removeLabel(num, label) {
    try { return await this.api.del(this._p(`/issues/${num}/labels/${encodeURIComponent(label)}`)); }
    catch (e) { if (e.status === 404) return null; throw e; }
  }
  getLabels(num)           { return this.api.get(this._p(`/issues/${num}/labels`)); }

  // Assignees
  addAssignees(num, users) { return this.api.post(this._p(`/issues/${num}/assignees`), { assignees: users }); }

  // Pull requests
  getPR(num)               { return this.api.get(this._p(`/pulls/${num}`)); }
  getPRReviews(num)        { return this.api.get(this._p(`/pulls/${num}/reviews?per_page=100`)); }
  getPRCommits(num)        { return this.api.get(this._p(`/pulls/${num}/commits?per_page=100`)); }
  getOpenPRs()             { return this.api.get(this._p('/pulls?state=open&per_page=100')); }
  createPR(data)           { return this.api.post(this._p('/pulls'), data); }
  mergePR(num, body)       { return this.api.put(this._p(`/pulls/${num}/merge`), body); }

  // CI
  getCombinedStatus(sha)   { return this.api.get(this._p(`/commits/${sha}/status`)); }
  getCheckRuns(sha)        { return this.api.get(this._p(`/commits/${sha}/check-runs?per_page=100`)); }

  async allCIGreen(sha) {
    const [status, checks] = await Promise.all([
      this.getCombinedStatus(sha),
      this.getCheckRuns(sha).catch(() => ({ check_runs: [] })),
    ]);
    if (['failure', 'error', 'pending'].includes(status.state)) return false;
    for (const r of (checks.check_runs ?? [])) {
      if (r.status !== 'completed') return false;
      if (['failure', 'timed_out', 'startup_failure'].includes(r.conclusion)) return false;
    }
    return true;
  }

  // Branches / refs
  async branchExists(branch) {
    try { await this.api.get(this._p(`/branches/${encodeURIComponent(branch)}`)); return true; }
    catch (e) { if (e.status === 404) return false; throw e; }
  }

  getRef(ref)              { return this.api.get(this._p(`/git/ref/${ref}`)); }
  createRef(ref, sha)      { return this.api.post(this._p('/git/refs'), { ref, sha }); }
  updateRef(ref, sha)      { return this.api.patch(this._p(`/git/ref/${ref}`), { sha, force: true }); }
  deleteRef(ref)           { return this.api.del(this._p(`/git/ref/${ref}`)); }

  // Git objects
  getCommit(sha)           { return this.api.get(this._p(`/git/commits/${sha}`)); }
  createCommit(body)       { return this.api.post(this._p('/git/commits'), body); }
  getTree(sha)             { return this.api.get(this._p(`/git/trees/${sha}?recursive=0`)); }
  createTree(body)         { return this.api.post(this._p('/git/trees'), body); }
  getBlob(sha)             { return this.api.get(this._p(`/git/blobs/${sha}`)); }

  // Repos
  async forkExists(forkOwner) {
    try { await this.api.get(`/repos/${forkOwner}/${this.repo}`); return true; }
    catch (e) { if (e.status === 404) return false; throw e; }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function sortBranchesDesc(branches) {
  return [...branches].sort((a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pb[i] ?? 0) - (pa[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  });
}

function makeGitHubHelper(config) {
  const api = new GitHubAPI(config);
  return new GitHubHelper(api, { owner: config.upstreamOwner, repo: config.upstreamRepo });
}

module.exports = { GitHubAPI, GitHubHelper, makeGitHubHelper, sortBranchesDesc, _sleep };
