/**
 * Persistence for offsets, quota counters, suggestions and summaries.
 *
 * The browser always loads from disk first; SSE only carries deltas, so a page
 * reload or a dsh restart never loses position.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  assistRoot,
  stateFile,
  suggestionsFile,
  summaryFile,
  summariesDir,
} from './paths.js';

const MAX_SUGGESTIONS = 200;
const KEEP_AFTER_ROTATE = 100;

function emptyState() {
  return { version: 1, reads: {}, analysis: {}, quota: { day: '', daily: 0, hourly: {} } };
}

function dayKey(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeAtomic(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, file);
}

export class Store {
  constructor({ logger } = {}) {
    this.logger = logger;
    this.loaded = null;
    this.saving = null;
  }

  async ensureLoaded() {
    if (this.loaded) return this.loaded;
    const raw = await readJson(stateFile(), null);
    const state = { ...emptyState(), ...(raw ?? {}) };
    state.reads ??= {};
    state.analysis ??= {};
    state.quota ??= { day: '', daily: 0, hourly: {} };
    state.quota.hourly ??= {};
    this.loaded = state;
    return state;
  }

  async save() {
    if (!this.loaded) return;
    if (this.saving) return this.saving;
    this.saving = (async () => {
      try {
        await writeAtomic(stateFile(), JSON.stringify(this.loaded, null, 2));
      } catch (error) {
        this.warn(`state save failed: ${error?.message ?? error}`);
      } finally {
        this.saving = null;
      }
    })();
    return this.saving;
  }

  warn(message) {
    if (typeof this.logger?.warn === 'function') this.logger.warn(`[qoder-assist] ${message}`);
    else console.warn(`[qoder-assist] ${message}`);
  }

  async readOffset(sessionId) {
    return (await this.ensureLoaded()).reads[sessionId] ?? 0;
  }

  async setReadOffset(sessionId, offset) {
    const state = await this.ensureLoaded();
    state.reads[sessionId] = Math.max(state.reads[sessionId] ?? 0, Number(offset) || 0);
    await this.save();
  }

  async analysis(sessionId) {
    const state = await this.ensureLoaded();
    state.analysis[sessionId] ??= {};
    return state.analysis[sessionId];
  }

  async updateAnalysis(sessionId, patch) {
    const record = await this.analysis(sessionId);
    Object.assign(record, patch);
    await this.save();
    return record;
  }

  async quota() {
    const state = await this.ensureLoaded();
    const today = dayKey();
    if (state.quota.day !== today) {
      state.quota.day = today;
      state.quota.daily = 0;
      state.quota.hourly = {};
    }
    return state.quota;
  }

  /** Reserve one analysis slot; returns ok=false when a cap is hit. */
  async takeQuota(sessionId, { hourlyCap, dailyCap, force = false, ignoreHourly = false }) {
    const quota = await this.quota();
    if (!force && quota.daily >= dailyCap) return { ok: false, reason: 'daily quota reached' };
    const now = Date.now();
    const slot = quota.hourly[sessionId];
    if (slot && now - slot.windowStart < 60 * 60 * 1000) {
      if (!force && !ignoreHourly && slot.count >= hourlyCap) return { ok: false, reason: 'hourly quota reached' };
      slot.count += 1;
    } else {
      quota.hourly[sessionId] = { windowStart: now, count: 1 };
    }
    quota.daily += 1;
    await this.save();
    return { ok: true };
  }

  async quotaStatus({ hourlyCap, dailyCap }) {
    const quota = await this.quota();
    const now = Date.now();
    const sessions = Object.entries(quota.hourly).map(([id, slot]) => ({
      sessionId: id,
      used: now - slot.windowStart < 60 * 60 * 1000 ? slot.count : 0,
      cap: hourlyCap,
    }));
    return { daily: { used: quota.daily, cap: dailyCap }, sessions };
  }

  // ------------------------------------------------------------ suggestions

  async readSuggestions(sessionId) {
    try {
      const raw = await fs.readFile(suggestionsFile(sessionId), 'utf8');
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  async appendSuggestion(sessionId, suggestion) {
    const file = suggestionsFile(sessionId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify(suggestion)}\n`, 'utf8');
    const all = await this.readSuggestions(sessionId);
    if (all.length > MAX_SUGGESTIONS) {
      const kept = all.slice(-KEEP_AFTER_ROTATE);
      await writeAtomic(file, kept.map((item) => JSON.stringify(item)).join('\n') + '\n');
    }
    return suggestion;
  }

  async suggestionFeedback(sessionId, suggestionId, itemIndex, value) {
    const file = suggestionsFile(sessionId);
    const all = await this.readSuggestions(sessionId);
    const target = all.find((item) => item.id === suggestionId);
    if (!target) return false;
    const item = target.items?.[itemIndex];
    if (!item) return false;
    item.feedback = value === 'down' ? 'down' : 'up';
    await writeAtomic(file, all.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    return true;
  }

  // -------------------------------------------------------------- summaries

  async readSummary(project, sessionId) {
    try {
      return await fs.readFile(summaryFile(project, sessionId), 'utf8');
    } catch {
      return '';
    }
  }

  async writeSummary(project, session, markdown) {
    await fs.mkdir(summariesDir(project), { recursive: true });
    const stamp = new Date().toISOString();
    const header = [
      `# Qoder CLI 会话摘要 · ${session.title || session.id}`,
      '',
      `- 会话：\`${session.id}\``,
      `- 项目：${session.cwd || session.project}`,
      `- 更新：${stamp}`,
      '',
      markdown.trim(),
      '',
    ].join('\n');
    await writeAtomic(summaryFile(project, session.id), header);
    return header;
  }

  async ensureRoot() {
    await fs.mkdir(assistRoot(), { recursive: true });
  }
}
