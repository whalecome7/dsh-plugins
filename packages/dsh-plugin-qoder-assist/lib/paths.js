/**
 * On-disk layout for the Qoder Assist plugin.
 *
 * Everything lives under `~/.dsh/qoder-assist/` because the sessions being
 * observed belong to arbitrary repositories; writing into those repos would
 * pollute work trees and risk being picked up by agents or git.
 */

import os from 'node:os';
import path from 'node:path';

export const ANALYST_MARKER = '[DSH_QODER_ASSIST_ANALYST]';
export const ANALYST_PROJECT_SUFFIX = 'dsh-qoder-assist-workspace';

export function assistRoot() {
  return path.join(os.homedir(), '.dsh', 'qoder-assist');
}

export function qoderRoot() {
  return path.join(os.homedir(), '.qoder');
}

export function qoderProjectsRoot() {
  return path.join(qoderRoot(), 'projects');
}

export function qoderSettingsFile() {
  return path.join(qoderRoot(), 'settings.json');
}

export function qoderVersionFile() {
  return path.join(qoderRoot(), 'bin', 'qodercli', 'version.txt');
}

export function analystWorkspace() {
  return path.join(assistRoot(), 'workspace');
}

export function stateFile() {
  return path.join(assistRoot(), 'state.json');
}

export function hooksSpool() {
  return path.join(assistRoot(), 'hooks.jsonl');
}

export function hooksSpoolRotated() {
  return path.join(assistRoot(), 'hooks.jsonl.1');
}

export function summariesDir(project) {
  return path.join(assistRoot(), 'summaries', project || '_');
}

export function summaryFile(project, sessionId) {
  return path.join(summariesDir(project), `${sessionId}.md`);
}

export function suggestionsFile(sessionId) {
  return path.join(assistRoot(), 'suggestions', `${sessionId}.jsonl`);
}

export function lockFile(sessionId) {
  return path.join(assistRoot(), 'locks', `${sessionId}.lock`);
}

export function logsDir() {
  return path.join(assistRoot(), 'logs');
}
