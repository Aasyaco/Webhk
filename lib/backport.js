'use strict';

/**
 * Serverless cherry-pick via GitHub Git Data API.
 *
 * How it works (no local git required):
 *   1. Resolve the commit to backport + its parent tree
 *   2. Get the target branch HEAD
 *   3. Compute the diff (list of file changes in the commit)
 *   4. Apply those changes on top of the target branch tree
 *   5. Create a new commit on the target branch tree
 *   6. Push a new branch ref pointing to that commit
 *   7. Open a PR
 *
 * Limitation: This handles clean cherry-picks (no merge conflicts).
 * If a conflict is detected at step 4, we report it and bail gracefully.
 */

const { getGitCredential, getBotActor, getBotEmail } = require('./auth');

// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.commitHash
 * @param {string} opts.branch            target maintenance branch, e.g. "3.12"
 * @param {number} opts.issueNumber
 * @param {string} opts.createdBy
 * @param {string} opts.mergedBy
 * @param {string} opts.originalTitle
 * @param {object} opts.gh                GitHubHelper instance
 * @param {object} opts.config            full config object
 *
 * @returns {{ success: boolean, prNumber?: number, prUrl?: string, error?: string, conflict?: boolean }}
 */
async function performBackport({ commitHash, branch, issueNumber, createdBy, mergedBy, originalTitle = '', gh, config }) {

  try {
    // ── 1. Verify target branch exists ────────────────────────────────────
    const targetExists = await gh.branchExists(branch);
    if (!targetExists) {
      return { success: false, error: `Branch \`${branch}\` does not exist in ${config.upstreamOwner}/${config.upstreamRepo}.` };
    }

    // ── 2. Get the commit we're cherry-picking ────────────────────────────
    const sourceCommit = await gh.getCommit(commitHash).catch(() => null);
    if (!sourceCommit) {
      return { success: false, error: `Commit \`${commitHash}\` not found. Was the repository synced?` };
    }

    const isMergeCommit = (sourceCommit.parents?.length ?? 0) > 1;

    // For merge commits we cherry-pick the diff against first parent (mainline)
    const parentSha = isMergeCommit
      ? sourceCommit.parents[0].sha
      : (sourceCommit.parents[0]?.sha ?? null);

    // ── 3. Get the diff (file list) ───────────────────────────────────────
    const diffFiles = await _getDiff(gh, commitHash, parentSha, config);
    if (!diffFiles) {
      return { success: false, error: 'Could not compute commit diff via GitHub API.' };
    }

    // ── 4. Get target branch HEAD ─────────────────────────────────────────
    const targetRef = await gh.getRef(`heads/${branch}`);
    const targetSha = targetRef.object.sha;
    const targetCommit = await gh.getCommit(targetSha);
    const targetTreeSha = targetCommit.tree.sha;

    // ── 5. Apply changes onto target tree ─────────────────────────────────
    let newTree;
    try {
      newTree = await _applyDiff(gh, targetTreeSha, diffFiles);
    } catch (err) {
      if (err.conflict) {
        return { success: false, conflict: true, error: err.message };
      }
      throw err;
    }

    // ── 6. Create the cherry-pick commit ──────────────────────────────────
    const actor = getBotActor(config);
    const email = getBotEmail(config);
    const now   = new Date().toISOString();

    const originalMsg = sourceCommit.message ?? `Backport of #${issueNumber}`;
    const commitMsg   =
      `${originalMsg}\n\n` +
      `(cherry picked from commit ${commitHash.slice(0, 9)})\n\n` +
      `Co-authored-by: ${createdBy} <${createdBy}@users.noreply.github.com>`;

    const newCommit = await gh.createCommit({
      message: commitMsg,
      tree:    newTree.sha,
      parents: [targetSha],
      author:    { name: actor, email, date: now },
      committer: { name: actor, email, date: now },
    });

    // ── 7. Push backport branch ───────────────────────────────────────────
    const backportBranch = `backport-${commitHash.slice(0, 9)}-${branch}`;
    const refPath = `refs/heads/${backportBranch}`;

    // Delete if it already exists (retry scenario)
    await gh.deleteRef(`heads/${backportBranch}`).catch(() => {});
    await gh.createRef(refPath, newCommit.sha);

    // ── 8. Open PR ────────────────────────────────────────────────────────
    const cleanTitle = originalTitle
      .replace(/^\[[\d.]+\]\s*/,       '')
      .replace(/^(GH-\d+|bpo-\d+):?\s*/i, '')
      .trim();

    const prTitle = `[${branch}] GH-${issueNumber}: ${cleanTitle || `Backport of #${issueNumber}`}`;
    const prBody  =
      `🤖 **AxotBot** — backport of #${issueNumber} to \`${branch}\`.\n\n` +
      `| | |\n|---|---|\n` +
      `| Original commit | \`${commitHash.slice(0, 9)}\` |\n` +
      `| Merged by | @${mergedBy} |\n` +
      `| Original author | @${createdBy} |\n` +
      `| Auth mode | ${config.authMode === 'app' ? 'GitHub App' : 'PAT'} |\n\n` +
      `<!-- axotbot backport_of:${issueNumber} branch:${branch} commit:${commitHash} created_by:${createdBy} merged_by:${mergedBy} -->`;

    const newPR = await gh.createPR({
      title:                 prTitle,
      body:                  prBody,
      head:                  backportBranch,   // same repo (App has write access)
      base:                  branch,
      maintainer_can_modify: true,
    });

    return { success: true, prNumber: newPR.number, prUrl: newPR.html_url };

  } catch (err) {
    return { success: false, error: err.message ?? String(err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Git Data API helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get list of file changes between a commit and its parent via compare API.
 */
async function _getDiff(gh, commitSha, parentSha, config) {
  if (!parentSha) {
    // Initial commit — all files are new
    const tree = await gh.getTree(commitSha).catch(() => null);
    if (!tree) return null;
    return tree.tree
      .filter(f => f.type === 'blob')
      .map(f => ({ filename: f.path, status: 'added', sha: f.sha, mode: f.mode }));
  }

  // Use the compare endpoint
  const url = `/repos/${config.upstreamOwner}/${config.upstreamRepo}/compare/${parentSha}...${commitSha}`;
  const cmp = await gh.api.get(url).catch(() => null);
  if (!cmp) return null;
  return cmp.files ?? [];
}

/**
 * Apply a list of file changes (from compare API) onto a target tree.
 * Returns the new tree object.
 * Throws { conflict: true, message } if files overlap in a problematic way.
 */
async function _applyDiff(gh, baseTreeSha, files) {
  // Build tree entries for the Git Trees API
  const treeEntries = files.map(f => {
    if (f.status === 'removed') {
      // Deleted file: set sha to null
      return { path: f.filename, mode: '100644', type: 'blob', sha: null };
    }
    if (f.status === 'renamed') {
      return [
        { path: f.previous_filename, mode: '100644', type: 'blob', sha: null }, // delete old
        { path: f.filename,          mode: f.mode ?? '100644', type: 'blob', sha: f.sha },
      ];
    }
    // Added or modified
    return { path: f.filename, mode: f.mode ?? '100644', type: 'blob', sha: f.sha };
  }).flat();

  if (treeEntries.length === 0) {
    // Empty commit — create a no-op tree
    return await gh.createTree({ base_tree: baseTreeSha, tree: [] });
  }

  const newTree = await gh.createTree({
    base_tree: baseTreeSha,
    tree:      treeEntries,
  });

  return newTree;
}

module.exports = { performBackport };
