/**
 * Optional qodercli hooks.
 *
 * Hooks never carry conversation text, so they only supplement the transcript:
 * exact session start/end, permission prompts, and turn boundaries. The command
 * is deliberately trivial (`cat >> spool`) so a broken hook can never block the
 * terminal.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { hooksSpool, hooksSpoolRotated, qoderSettingsFile } from './paths.js';

export const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'PermissionRequest', 'Stop'];

export const HOOK_COMMAND =
  'sh -c \'mkdir -p "$HOME/.dsh/qoder-assist" 2>/dev/null; { cat; echo; } >> "$HOME/.dsh/qoder-assist/hooks.jsonl" 2>/dev/null; exit 0\'';

const MAX_SPOOL_BYTES = 5 * 1024 * 1024;

async function readSettings() {
  try {
    return JSON.parse(await fs.readFile(qoderSettingsFile(), 'utf8'));
  } catch {
    return {};
  }
}

async function writeSettings(settings) {
  const file = qoderSettingsFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.copyFile(file, `${file}.bak`);
  } catch {}
  await fs.writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function hasOurs(groups) {
  return (groups ?? []).some((group) => (group?.hooks ?? []).some((hook) => hook?.command === HOOK_COMMAND));
}

export async function hooksStatus() {
  const settings = await readSettings();
  const events = {};
  for (const event of HOOK_EVENTS) events[event] = hasOurs(settings.hooks?.[event]);
  const installed = Object.values(events).every(Boolean);
  const partial = Object.values(events).some(Boolean);
  return { installed, partial, events, settingsFile: qoderSettingsFile(), spoolFile: hooksSpool() };
}

export async function installHooks() {
  const settings = await readSettings();
  settings.hooks ??= {};
  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    if (!hasOurs(groups)) groups.push({ hooks: [{ type: 'command', command: HOOK_COMMAND }] });
    settings.hooks[event] = groups;
  }
  await writeSettings(settings);
  return hooksStatus();
}

export async function uninstallHooks() {
  const settings = await readSettings();
  if (settings.hooks && typeof settings.hooks === 'object') {
    for (const event of HOOK_EVENTS) {
      const groups = settings.hooks[event];
      if (!Array.isArray(groups)) continue;
      const kept = groups
        .map((group) => ({
          ...group,
          hooks: (group?.hooks ?? []).filter((hook) => hook?.command !== HOOK_COMMAND),
        }))
        .filter((group) => group.hooks.length > 0);
      if (kept.length) settings.hooks[event] = kept;
      else delete settings.hooks[event];
    }
    if (!Object.keys(settings.hooks).length) delete settings.hooks;
  }
  await writeSettings(settings);
  return hooksStatus();
}

/**
 * Read hook payloads appended since `offset`.
 * Returns complete JSON lines only; a trailing partial line stays for next time.
 */
export async function readHookEvents(offset) {
  const file = hooksSpool();
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return { events: [], offset };
  }

  let start = offset;
  if (stat.size < start) start = 0;

  let events = [];
  let next = start;
  if (stat.size > start) {
    const fh = await fs.open(file, 'r');
    const buffer = Buffer.alloc(stat.size - start);
    const { bytesRead } = await fh.read(buffer, 0, buffer.length, start);
    await fh.close();
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline >= 0) {
      for (const line of text.slice(0, lastNewline).split('\n')) {
        if (!line) continue;
        try {
          events.push(JSON.parse(line));
        } catch {}
      }
      next = start + Buffer.byteLength(text.slice(0, lastNewline + 1), 'utf8');
    }
  }

  if (stat.size > MAX_SPOOL_BYTES) {
    try {
      await fs.rename(file, hooksSpoolRotated());
      next = 0;
    } catch {}
  }

  return { events, offset: next };
}
