/**
 * Where the Qoder panel keeps its own artifacts.
 *
 * Deliberately *not* under `.qoder/`: qodercli treats that directory as a
 * protected config path and refuses agent writes into it (verified — a Write to
 * `.qoder/perm-test.txt` is rejected by built-in sensitive-path protection).
 */

import path from 'node:path';

/** Root of this plugin's on-disk data for a workspace. */
export function dataDir(cwd) {
  return path.join(cwd, '.dsh', 'qoder');
}

/** Rolling summary markdown, one file per panel session. */
export function summariesDir(cwd) {
  return path.join(dataDir(cwd), 'summaries');
}

/** Per-turn `git diff` snapshots, used for after-the-fact review. */
export function snapshotsDir(cwd) {
  return path.join(dataDir(cwd), 'snapshots');
}

/** Paths this plugin owns; excluded from the "workspace is dirty" guard. */
export const OWNED_PATH_PREFIXES = ['.dsh/', '.qoder/'];

/** Whether a repo-relative path belongs to this plugin's own artifacts. */
export function isOwnedPath(relPath) {
  const normalized = String(relPath).replaceAll('\\', '/');
  return OWNED_PATH_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix));
}
