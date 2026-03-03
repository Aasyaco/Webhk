# 🐍🍒⛏🤖 AxotBot v3.0

**Vercel-native** backport & merge automation bot for [zrsx/cpython](https://github.com/zrsx/cpython), powered by the [AxotBot](https://github.com/apps/AxotBot) GitHub App.

Zero runtime dependencies. Runs entirely on Vercel's serverless infrastructure — no server, no Redis, no Celery, no git binary required.

---

## Auth Modes

AxotBot supports **two authentication modes**, detected automatically from environment variables:

### Mode A: GitHub App *(recommended)*

Set all three:
```
GITHUB_APP_ID=<your app id>
GITHUB_APP_PRIVATE_KEY=<PEM content>
GITHUB_APP_INSTALLATION_ID=<installation id>
```

**Benefits:** Fine-grained permissions, tokens auto-rotate every hour, audit trail shows "AxotBot" as the actor, no PAT expiry to manage.

### Mode B: Personal Access Token

Set one:
```
GITHUB_TOKEN=ghp_xxxxxxxxxxxx
```

**When to use:** Quick setup, personal fork, testing. Requires `repo` + `workflow` scopes.

> If both are set, **GitHub App mode takes priority**.

---

## Deploy to Vercel

```bash
# 1. Clone
git clone https://github.com/YOUR_USERNAME/axotbot
cd axotbot

# 2. Install Vercel CLI (dev only)
npm install

# 3. Deploy
npx vercel --prod

# 4. Set environment variables in Vercel dashboard:
#    Project → Settings → Environment Variables
#    (or use: vercel env add VARIABLE_NAME)
```

### Required Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GITHUB_SECRET` | ✅ always | Webhook HMAC secret |
| `GITHUB_APP_ID` | ✅ (App mode) | GitHub App numeric ID |
| `GITHUB_APP_PRIVATE_KEY` | ✅ (App mode) | PEM private key (paste full content) |
| `GITHUB_APP_INSTALLATION_ID` | ✅ (App mode) | Installation ID from GitHub |
| `GITHUB_TOKEN` | ✅ (PAT mode) | Personal access token (`repo` + `workflow`) |
| `KV_REST_API_URL` | optional | Vercel KV URL for persistent stats |
| `KV_REST_API_TOKEN` | optional | Vercel KV token |

### Optional Variables

| Variable | Default | Description |
|---|---|---|
| `BOT_USERNAME` | `AxotBot` | GitHub account that opens PRs |
| `UPSTREAM_OWNER` | `zrsx` | Fork owner |
| `UPSTREAM_REPO` | `cpython` | Repo name |
| `MERGE_METHOD` | `squash` | `squash` / `merge` / `rebase` |
| `CI_SETTLE_MS` | `8000` | Wait after CI event (ms) |
| `MAX_COMMITS_FOR_AUTOMERGE` | `1` | Skip auto-merge if PR has more commits |

---

## Register the Webhook

After deploying, configure a webhook on `zrsx/cpython`:

```
URL:           https://your-project.vercel.app/api/webhook
Content-Type:  application/json
Secret:        (same as GITHUB_SECRET)
Events:
  ✅ Pull requests
  ✅ Pull request reviews
  ✅ Statuses
  ✅ Check runs
  ✅ Check suites
  ✅ GitHub Apps (if using App mode)
```

---

## How Cherry-Pick Works (Serverless)

Traditional miss-islington clones a git repo locally. AxotBot v3 uses the **GitHub Git Data API** to perform cherry-picks entirely over HTTPS — no local git, no filesystem, Vercel-compatible:

```
1. Verify target branch exists
2. GET /git/commits/:sha → resolve commit + parent
3. GET /repos/.../compare/:base...:head → diff (file list)
4. GET current branch HEAD sha
5. POST /git/trees with base_tree + diff entries → new tree sha
6. POST /git/commits with new tree + target parent → new commit sha
7. POST /git/refs → push backport branch
8. POST /pulls → open PR
```

Merge conflicts are detected at step 5 and reported clearly in a PR comment.

---

## Project Structure

```
axotbot/
├── api/
│   ├── webhook.js       ← Main webhook handler (Vercel Serverless Function)
│   ├── stats.js         ← Dashboard stats endpoint
│   ├── activity.js      ← Recent events endpoint
│   └── health.js        ← Health check
├── lib/
│   ├── config.js        ← Dual-auth config loader
│   ├── auth.js          ← GitHub App JWT + PAT auth
│   ├── github.js        ← GitHub API client + GitHubHelper
│   ├── backport.js      ← Serverless cherry-pick via Git Data API
│   ├── handlers.js      ← All event handlers
│   ├── state.js         ← Stats (Vercel KV + in-memory fallback)
│   ├── webhook.js       ← HMAC signature verification
│   └── logger.js        ← Structured JSON logger
├── public/
│   └── index.html       ← Dashboard UI (static, polling /api/stats)
├── tests/
│   └── test.js          ← 22 tests, Node built-in runner
├── vercel.json          ← Routing + function config
├── package.json
└── .env.example
```

---

## Running Tests

```bash
npm test
```

22 tests, zero dependencies, Node 20 built-in runner.

---

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/` | GET | Dashboard UI |
| `/api/webhook` | POST | GitHub webhook receiver |
| `/api/stats` | GET | Bot stats (JSON) |
| `/api/activity` | GET | Recent backport/merge events |
| `/health` | GET | Health + auth mode check |
