/**
 * Handles merge conflicts and informs maintainers.
 */
export async function handleConflict(
  octokit,
  owner,
  repo,
  prNumber,
  targetBranch
) {
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body:
      `⚠️ Automatic backport to \`${targetBranch}\` failed.\n\n` +
      `This PR has merge conflicts.\n` +
      `Please backport manually.`,
  });
}
