import { getInstallationOctokit } from "../lib/github.js";
import { cherryPickBackport } from "../lib/backport/cherryPick.js";
import { handleConflict } from "../lib/backport/conflict.js";
import { scheduleRetry } from "../lib/backport/retryQueue.js";

export async function handleBackportEvent(payload) {
  const pr = payload.pull_request;

  if (!pr?.merged) return;

  const labels = pr.labels.map(l => l.name);
  const targets = labels.filter(l =>
    l.startsWith("needs backport to ")
  );

  if (!targets.length) return;

  const octokit = await getInstallationOctokit();

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;

  for (const label of targets) {
    const branch = label.replace("needs backport to ", "").trim();
    const retryKey = `${pr.number}-${branch}`;

    try {
      await cherryPickBackport({
        octokit,
        owner,
        repo,
        pullRequest: pr,
        targetBranch: branch,
      });

      /* Remove label after success */
      await octokit.issues.removeLabel({
        owner,
        repo,
        issue_number: pr.number,
        name: label,
      });

    } catch (err) {
      if (err.message === "MERGE_CONFLICT") {
        await handleConflict(
          octokit,
          owner,
          repo,
          pr.number,
          branch
        );

        scheduleRetry(retryKey, async () => {
          await cherryPickBackport({
            octokit,
            owner,
            repo,
            pullRequest: pr,
            targetBranch: branch,
          });
        });
      } else {
        console.error("Backport error:", err.message);
      }
    }
  }
}
