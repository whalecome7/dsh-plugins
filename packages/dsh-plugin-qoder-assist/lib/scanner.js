/**
 * Discover qodercli sessions and tail their JSONL files.
 *
 * The transcript files are the source of truth; hooks only contribute events
 * that never appear in them (permission prompts, session boundaries).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { ANALYST_MARKER, ANALYST_PROJECT_SUFFIX, qoderProjectsRoot } from './paths.js';
import { aiTitle, isMetaUserText, parseRecord } from './transcript.js';

const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
const HEAD_BYTES = 128 * 1024;
const metaCache = new Map();
const cwdCache = new Map();

async function readCwd(projDir, sessionId) {
  const key = `${projDir}:${sessionId}`;
  if (cwdCache.has(key)) return cwdCache.get(key);
  let cwd = null;
  try {
    const raw = await fs.readFile(path.join(projDir, sessionId, 'state.json'), 'utf8');
    const state = JSON.parse(raw);
    if (state.workspaceDirectories?.[0]) cwd = state.workspaceDirectories[0];
  } catch {}
  cwdCache.set(key, cwd);
  return cwd;
}

function scanHead(text) {
  let title = null;
  let marker = false;
  let sawUser = false;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const foundTitle = aiTitle(record);
    if (foundTitle) title = foundTitle;
    if (record?.type === 'user' && !sawUser) {
      const content = record.message?.content;
      const first = typeof content === 'string' ? content : content?.find?.((block) => block?.type === 'text')?.text;
      if (typeof first === 'string' && !isMetaUserText(first)) {
        sawUser = true;
        if (first.includes(ANALYST_MARKER)) marker = true;
      }
    }
  }
  return { title, marker };
}

async function headMeta(file, mtimeMs) {
  const key = `${file}:${mtimeMs}`;
  const cached = metaCache.get(key);
  if (cached) return cached;
  let meta = { title: null, marker: false };
  try {
    const fh = await fs.open(file, 'r');
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buffer, 0, HEAD_BYTES, 0);
    await fh.close();
    meta = scanHead(buffer.subarray(0, bytesRead).toString('utf8'));
  } catch {}
  metaCache.set(key, meta);
  if (metaCache.size > 2000) metaCache.clear();
  return meta;
}

/**
 * @returns {Promise<Array<{
 *   id: string, file: string, project: string, projectLabel: string,
 *   cwd: string|null, title: string|null, size: number, mtime: number, active: boolean
 * }>>}
 */
export async function scanSessions() {
  let projects = [];
  try {
    projects = await fs.readdir(qoderProjectsRoot(), { withFileTypes: true });
  } catch {
    return [];
  }

  const now = Date.now();
  const out = [];

  for (const project of projects) {
    if (!project.isDirectory() || project.name.endsWith(ANALYST_PROJECT_SUFFIX)) continue;    const projDir = path.join(qoderProjectsRoot(), project.name);
    let files = [];
    try {
      files = await fs.readdir(projDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
      const full = path.join(projDir, file.name);
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      const id = file.name.slice(0, -'.jsonl'.length);
      const meta = await headMeta(full, stat.mtimeMs);
      if (meta.marker) continue;
      const cwd = await readCwd(projDir, id);
      out.push({
        id,
        file: full,
        project: project.name,
        projectLabel: cwd ? path.basename(cwd) || cwd : project.name,
        cwd,
        title: meta.title,
        size: stat.size,
        mtime: stat.mtimeMs,
        active: now - stat.mtimeMs < ACTIVE_WINDOW_MS,
      });
    }
  }

  return out.sort((a, b) => b.mtime - a.mtime);
}

const decoder = new TextDecoder('utf8');

function parseBuffer(buffer, startOffset) {
  const messages = [];
  let cursor = 0;
  while (true) {
    const nl = buffer.indexOf(0x0a, cursor);
    if (nl === -1) break;
    const line = buffer.subarray(cursor, nl);
    const offset = startOffset + cursor;
    cursor = nl + 1;
    if (!line.length) continue;
    try {
      const parsed = parseRecord(JSON.parse(decoder.decode(line)), offset);
      if (parsed) messages.push(parsed);
    } catch {}
  }
  return { messages, consumed: cursor, remainder: buffer.subarray(cursor) };
}

/** Read the tail of a session file, keeping the newest `maxBytes`. */
export async function readTail(file, maxBytes = 512 * 1024) {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return { messages: [], offset: 0, lineStart: 0, pending: Buffer.alloc(0) };
  }
  const start = Math.max(0, stat.size - maxBytes);
  const fh = await fs.open(file, 'r');
  const buffer = Buffer.alloc(stat.size - start);
  const { bytesRead } = await fh.read(buffer, 0, buffer.length, start);
  await fh.close();
  const data = buffer.subarray(0, bytesRead);

  let base = start;
  let usable = data;
  if (start > 0) {
    const firstNewline = data.indexOf(0x0a);
    if (firstNewline === -1) return { messages: [], offset: stat.size, lineStart: stat.size, pending: Buffer.alloc(0) };
    usable = data.subarray(firstNewline + 1);
    base = start + firstNewline + 1;
  }

  const { messages, consumed } = parseBuffer(usable, base);
  return {
    messages,
    offset: stat.size,
    lineStart: base + consumed,
    pending: Buffer.from(usable.subarray(consumed)),
  };
}

/** Read a window ending at `endOffset`, used for "load earlier". */
export async function readRange(file, endOffset, maxBytes = 512 * 1024) {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return { messages: [], earliest: 0 };
  }
  const end = Math.min(endOffset || stat.size, stat.size);
  const start = Math.max(0, end - maxBytes);
  const fh = await fs.open(file, 'r');
  const buffer = Buffer.alloc(end - start);
  const { bytesRead } = await fh.read(buffer, 0, buffer.length, start);
  await fh.close();
  let base = start;
  let data = buffer.subarray(0, bytesRead);
  if (start > 0) {
    const nl = data.indexOf(0x0a);
    if (nl === -1) return { messages: [], earliest: end };
    data = data.subarray(nl + 1);
    base = start + nl + 1;
  }
  const { messages } = parseBuffer(data, base);
  return { messages, earliest: base };
}

/** Incremental tailer used by the live hub. */
export class Tailer {
  constructor(file) {
    this.file = file;
    this.offset = 0;
    this.lineStart = 0;
    this.pending = Buffer.alloc(0);
    this.inode = null;
    this.initialized = false;
  }

  async init(maxBytes = 512 * 1024) {
    const tail = await readTail(this.file, maxBytes);
    const stat = await fs.stat(this.file);
    this.offset = tail.offset;
    this.lineStart = tail.lineStart;
    this.pending = tail.pending;
    this.inode = stat.ino;
    this.initialized = true;
    return tail.messages;
  }

  /** @returns {Promise<{messages: object[], replaced: boolean, truncated: boolean}>} */
  async readNew() {
    let stat;
    try {
      stat = await fs.stat(this.file);
    } catch {
      return { messages: [], replaced: false, truncated: false };
    }
    let replaced = false;
    let truncated = false;

    if (this.inode !== null && stat.ino !== this.inode) {
      this.offset = 0;
      this.lineStart = 0;
      this.pending = Buffer.alloc(0);
      this.inode = stat.ino;
      replaced = true;
    }
    if (stat.size < this.offset) {
      this.offset = 0;
      this.lineStart = 0;
      this.pending = Buffer.alloc(0);
      truncated = true;
    }
    if (stat.size === this.offset) return { messages: [], replaced, truncated };

    const fh = await fs.open(this.file, 'r');
    const buffer = Buffer.alloc(stat.size - this.offset);
    const { bytesRead } = await fh.read(buffer, 0, buffer.length, this.offset);
    await fh.close();
    if (!bytesRead) return { messages: [], replaced, truncated };

    const data = Buffer.concat([this.pending, buffer.subarray(0, bytesRead)]);
    const { messages, consumed, remainder } = parseBuffer(data, this.lineStart);
    this.lineStart += consumed;
    this.offset += bytesRead;
    this.pending = Buffer.from(remainder);
    return { messages, replaced, truncated };
  }
}
