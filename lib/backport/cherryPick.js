/**
 * Performs automated backport.
 */
export async function cherryPickBackport({
  octokit,
  owner,
  repo,
  pullRequest,
  targetBranch,
}) {
  const sha = pullRequest.merge_commit_sha;
  const branch = `backport-${pullRequest.number}-to-${targetBranch}`;

  /* Prevent duplicate PR */
  const { data: existing } = await octokit.pulls.list({
    owner,
    repo,
    head: `${owner}:${branch}`,
    state: "open",
  });

  if (existing.length) return;

  /* Get base SHA */
  const { data: ref } = await octokit.git.getRef({
    owner,
    repo,
    ref: `heads/${targetBranch}`,
  });

  const baseSha = ref.object.sha;

  /* Create branch */
  await octokit.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branch}`,
    sha: baseSha,
  });

  /* Try merge (simulate cherry-pick) */
  try {
    await octokit.repos.merge({
      owner,
      repo,
      base: branch,
      head: sha,
      commit_message:
        `Backport #${pullRequest.number} to ${targetBranch}`,
    });
  } catch {
    throw new Error("MERGE_CONFLICT");
  }

  /* Create PR */
  await octokit.pulls.create({
    owner,
    repo,
    title: `[${targetBranch}] ${pullRequest.title}`,
    head: branch,
    base: targetBranch,
    body: `Automated backport of #${pullRequest.number}`,
  });
}
