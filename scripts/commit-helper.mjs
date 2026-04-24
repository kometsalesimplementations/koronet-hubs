/**
 * Shared commit + push helper for sync scripts.
 *
 * Context: when two workflows (sync-pmt + sync-fathom) run concurrently and
 * both try to push to main, the second push gets rejected because main moved.
 * The YAML step doesn't do `git pull --rebase` before push, so it fails.
 *
 * Fix: the script commits and pushes itself, with a pull --rebase retry loop.
 * The YAML's subsequent "Commit and push if changed" step becomes a no-op
 * (nothing staged left to commit).
 *
 * Only runs inside GitHub Actions (detects GITHUB_ACTIONS env var) so local
 * dev runs don't accidentally commit.
 */

import { execSync } from 'node:child_process';

function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: 'inherit', ...opts });
}

function runQuiet(cmd) {
  return execSync(cmd, { stdio: 'pipe' }).toString();
}

export function commitAndPush(message) {
  if (!process.env.GITHUB_ACTIONS) {
    console.log('[commit-helper] not in GitHub Actions, skipping commit/push');
    return;
  }

  run('git config user.name "koronet-hubs-bot"');
  run('git config user.email "bot@koronet.com"');
  run('git add data/');

  let hasChanges = false;
  try {
    runQuiet('git diff --cached --quiet');
  } catch {
    hasChanges = true;
  }

  if (!hasChanges) {
    console.log('[commit-helper] no staged changes, nothing to push');
    return;
  }

  run(`git commit -m ${JSON.stringify(message)}`);

  const maxAttempts = 3;
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      run('git pull --rebase origin main');
      run('git push');
      console.log(`[commit-helper] pushed on attempt ${i}`);
      return;
    } catch (e) {
      console.warn(`[commit-helper] push attempt ${i}/${maxAttempts} failed`);
      if (i === maxAttempts) {
        throw new Error(`push failed after ${maxAttempts} attempts`);
      }
      execSync('sleep 3');
    }
  }
}
