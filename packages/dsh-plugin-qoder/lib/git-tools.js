/**
 * Git helpers for the Qoder panel.
 *
 * Two jobs:
 *  - guard: refuse to start a task on a dirty working tree, so every task is
 *    reversible with `git checkout .`
 *  - review: capture what a task changed, to be rendered in the panel's diff view
 *
 * Everything degrades gracefully: when the workspace is not a git repo the
 * guard passes and the diff view reports "not a git repository" instead of
 * throwing.
 */

import { execFile } from 'node:child_process';
import { isOwnedPath } from './paths.js';

function run(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) resolve({ ok: false, code: error.code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      else resolve({ ok: true, code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/** `git rev-parse --is-inside-work-tree` */
export async function isGitRepo(cwd) {
  const result = await run(cwd, ['rev-parse', '--is-inside-work-tree']);
  return result.ok && result.stdout.trim() === 'true';
}

/**
 * Dirty-state guard.
 *
 * @returns {{isRepo: boolean, clean: boolean, entries: Array<{code: string, path: string}>}}
 */
export async function status(cwd) {
  if (!(await isGitRepo(cwd))) return { isRepo: false, clean: true, entries: [] };

  const result = await run(cwd, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (!result.ok) return { isRepo: true, clean: false, entries: [], error: result.stderr.trim() };

  const entries = result.stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => ({ code: line.slice(0, 2).trim(), path: line.slice(3).trim() }))
    .filter((entry) => !isOwnedPath(entry.path));

  return { isRepo: true, clean: entries.length === 0, entries };
}

/** Current branch + short HEAD, for the panel header. */
export async function head(cwd) {
  if (!(await isGitRepo(cwd))) return null;
  const branch = await run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const sha = await run(cwd, ['rev-parse', '--short', 'HEAD']);
  return {
    branch: branch.ok ? branch.stdout.trim() : '',
    sha: sha.ok ? sha.stdout.trim() : '',
  };
}

/**
 * Working-tree changes relative to HEAD, as a patch plus a per-file summary.
 *
 * Untracked files never appear in `git diff`, so they are listed separately and
 * their content is included as an "added file" patch so the review view is
 * complete.
 */
export async function diff(cwd) {
  if (!(await isGitRepo(cwd))) return { isRepo: false, patch: '', files: [], untracked: [] };

  const [patchResult, numstat, statusResult] = await Promise.all([
    run(cwd, ['diff', 'HEAD', '--no-color', '--unified=3', '--', '.']),
    run(cwd, ['diff', 'HEAD', '--numstat', '--', '.']),
    run(cwd, ['status', '--porcelain=v1', '--untracked-files=all']),
  ]);

  const files = [];
  if (numstat.ok) {
    for (const line of numstat.stdout.split('\n')) {
      if (!line.trim()) continue;
      const [additions, deletions, ...rest] = line.split('\t');
      const filePath = rest.join('\t');
      if (!filePath) continue;
      files.push({
        path: filePath,
        additions: additions === '-' ? 0 : Number(additions) || 0,
        deletions: deletions === '-' ? 0 : Number(deletions) || 0,
        binary: additions === '-' || deletions === '-',
      });
    }
  }

  const untracked = [];
  if (statusResult.ok) {
    for (const line of statusResult.stdout.split('\n')) {
      if (!line.startsWith('?? ')) continue;
      const filePath = line.slice(3).trim();
      if (filePath && !isOwnedPath(filePath)) untracked.push(filePath);
    }
  }

  let patch = patchResult.ok ? patchResult.stdout : '';
  for (const filePath of untracked.slice(0, 50)) {
    const content = await run(cwd, ['diff', '--no-index', '--no-color', '/dev/null', filePath]);
    if (content.stdout) patch += `\n${content.stdout}`;
  }

  return { isRepo: true, patch, files, untracked };
}
