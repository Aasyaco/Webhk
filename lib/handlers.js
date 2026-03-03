'use strict';

const { performBackport }  = require('./backport');
const { sortBranchesDesc, _sleep } = require('./github');
const { logger }           = require('./logger');
const state                = require('./state');

const EASTER_EGGS = [
  "I'm not a witch! I'm not a witch!",
  "She turned me into a newt! …I got better.",
  "We have found a witch! May we burn her?",
  "What is the air-speed velocity of an unladen swallow?",
  "I fart in your general direction.",
];

// ─────────────────────────────────────────────────────────────────────────────
// Backport handler
// ─────────────────────────────────────────────────────────────────────────────

async function handleBackportPR(payload, gh, config) {
  const { action, pull_request: pr, label } = payload;
  if (!pr?.merged) return;

  const issueNumber = pr.number;
  const commitHash  = pr.merge_commit_sha;
  const mergedBy    = pr.merged_by?.login;
  const createdBy   = pr.user?.login;
  const title       = pr.title ?? '';

  // Collect backport labels
  let labelsToCheck;
  if (action === 'labeled' && label) {
    labelsToCheck = [label];
  } else {
    labelsToCheck = await gh.getLabels(issueNumber).catch(() => []);
  }

  const branches = labelsToCheck
    .filter(l => l.name.startsWith(config.backportLabelPrefix))
    .map(l => l.name.slice(config.backportLabelPrefix.length).trim())
    .filter(Boolean);

  if (!branches.length) return;

  const sorted = sortBranchesDesc(branches);

  // Acknowledgement comment
  const egg    = Math.random() < 0.1 ? `\n> _${EASTER_EGGS[Math.floor(Math.random() * EASTER_EGGS.length)]}_` : '';
  const thanks = createdBy === mergedBy || mergedBy === config.botUsername
    ? `Thanks @${createdBy} for the PR 🌮🎉.`
    : `Thanks @${createdBy} for the PR, and @${mergedBy} for merging it 🌮🎉.`;

  await gh.leaveComment(
    issueNumber,
    `${thanks} I'm working to backport this PR to: ${sorted.map(b => `\`${b}\``).join(', ')}.\n🐍🍒⛏🤖${egg}`
  );

  // Backport each branch
  for (const branch of sorted) {
    await state.recordBackportAttempt(config, { prNumber: issueNumber, branch });
    logger.info(`Backporting #${issueNumber} → ${branch}`, { commit: commitHash?.slice(0, 9) });

    const result = await performBackport({
      commitHash, branch, issueNumber, createdBy, mergedBy,
      originalTitle: title, gh, config,
    });

    if (result.success) {
      await state.recordBackportSuccess(config, {
        prNumber: issueNumber, branch,
        newPrNumber: result.prNumber, prUrl: result.prUrl,
      });
      await gh.addLabel(issueNumber, `${config.backportSuccessLabel}-${branch}`).catch(() => {});
      logger.info(`Backport PR #${result.prNumber} opened`, { url: result.prUrl });
    } else {
      await state.recordBackportFailure(config, { prNumber: issueNumber, branch, error: result.error });

      await gh.leaveComment(
        issueNumber,
        `⚠️ I couldn't backport to \`${branch}\`. Please do it manually.\n\n` +
        `**Reason:** ${result.error}\n\ncc @${mergedBy}`
      );
      await gh.addAssignees(issueNumber, [mergedBy]).catch(() => {});
      await gh.removeLabel(issueNumber, `${config.backportLabelPrefix} ${branch}`).catch(() => {});
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Merge handler
// ─────────────────────────────────────────────────────────────────────────────

async function handleCIStatusChange(sha, gh, config) {
  await _sleep(config.ciSettleMs);

  if (!await gh.allCIGreen(sha)) {
    logger.debug(`CI not green for ${sha.slice(0, 9)}`);
    return;
  }

  const openPRs = await gh.getOpenPRs().catch(() => []);
  for (const pr of openPRs.filter(p => p.head?.sha === sha)) {
    await _tryAutoMerge(pr, gh, config);
  }
}

async function _tryAutoMerge(pr, gh, config) {
  const num     = pr.number;
  const creator = pr.user?.login;
  const labels  = (pr.labels ?? []).map(l => l.name);
  const isBot   = creator === config.botUsername || creator === `${config.botUsername}[bot]`;
  const hasAuto = labels.includes(config.automergeLabel);
  const hasAwait = labels.includes(config.awaitingMergeLabel);

  if (!isBot && !hasAuto && !hasAwait) return;

  const approved = await _isApproved(num, gh);
  if (!approved) { logger.info(`PR #${num} awaiting approval`); return; }

  // Commit count guard for bot PRs
  if (isBot) {
    const commits = await gh.getPRCommits(num).catch(() => []);
    if (commits.length > config.maxCommitsForAutomerge) {
      logger.warn(`PR #${num} has ${commits.length} commits, skipping auto-merge`);
      await gh.leaveComment(
        num,
        `⚠️ This backport PR has ${commits.length} commits (expected ${config.maxCommitsForAutomerge}). ` +
        `Please review and merge manually.`
      ).catch(() => {});
      return;
    }
  }

  // Re-fetch to confirm still open
  const fresh = await gh.getPR(num).catch(() => null);
  if (!fresh || fresh.state !== 'open' || fresh.merged) return;

  try {
    await gh.mergePR(num, {
      commit_title:   _buildTitle(fresh),
      commit_message: _buildMessage(fresh),
      merge_method:   config.mergeMethod,
    });
    logger.info(`✅ Auto-merged PR #${num}`);
    await state.recordMerge(config, { prNumber: num, title: fresh.title });
  } catch (err) {
    if ([405, 409, 422].includes(err.status)) {
      logger.warn(`PR #${num} not mergeable: ${err.message}`);
    } else throw err;
  }
}

async function _isApproved(num, gh) {
  const reviews = await gh.getPRReviews(num).catch(() => []);
  const latest  = new Map();
  for (const r of reviews) {
    if (r.state !== 'COMMENTED') latest.set(r.user.login, r.state);
  }
  return [...latest.values()].includes('APPROVED');
}

function _buildTitle(pr) {
  const base = pr.title?.trim() ?? '';
  return /^(GH-|bpo-)\d+/i.test(base) ? base : `GH-${pr.number}: ${base}`;
}

function _buildMessage(pr) {
  return `Co-authored-by: ${pr.user.login} <${pr.user.login}@users.noreply.github.com>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Review / label handlers
// ─────────────────────────────────────────────────────────────────────────────

async function handlePRReview(payload, gh, config) {
  const { review, pull_request: pr } = payload;
  if (review?.state?.toLowerCase() !== 'approved' || !pr) return;
  logger.info(`PR #${pr.number} approved by @${review.user.login}`);
  await handleCIStatusChange(pr.head.sha, gh, config);
}

async function handlePRLabeled(payload, gh, config) {
  const { label, pull_request: pr } = payload;
  if (!label || !pr) return;
  if (label.name !== config.automergeLabel) return;
  logger.info(`Automerge label on PR #${pr.number}`);
  await handleCIStatusChange(pr.head.sha, gh, config);
}

module.exports = { handleBackportPR, handleCIStatusChange, handlePRReview, handlePRLabeled };
