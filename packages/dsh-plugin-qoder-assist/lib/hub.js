/**
 * Live hub: ties scanners, tailers, hooks and the analyser together.
 *
 * Everything the browser sees is either persisted state (read first) or a
 * small SSE delta (appended later); no large payload ever travels over SSE.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { Analyzer } from './analyzer.js';
import { assistRoot } from './paths.js';
import { readHookEvents } from './hooks.js';
import { readRange, scanSessions, Tailer } from './scanner.js';
import { Store } from './store.js';
import { TURN_END } from './transcript.js';

const POLL_MS = 1000;
const SCAN_MS = 15000;
const ANALYZE_MS = 10000;
const HOOKS_MS = 5000;
const IDLE_FINAL_MS = 10 * 60 * 1000;
const MAX_EVENTS = 4000;
const MAX_MESSAGES = 4000;
const INITIAL_TAIL_BYTES = 512 * 1024;
const PAGE_BYTES = 512 * 1024;

export class Hub {
  constructor({ cwd, logger }) {
    this.cwd = cwd;
    this.logger = logger;
    this.store = new Store({ logger });
    this.metas = new Map();
    this.runtimes = new Map();
    this.events = [];
    this.seq = 0;
    this.subs = new Set();
    this.defaultSessionId = null;
    this.timers = [];
    this.hookOffset = null;
    this.disposed = false;
    this.analyzer = new Analyzer({
      store: this.store,
      logger,
      emit: (event) => this.push(event),
    });
    this.analyzer.messageSource = (session) => this.runtimeMessages(session.id);
  }

  warn(message) {
    if (typeof this.logger?.warn === 'function') this.logger.warn(`[qoder-assist] ${message}`);
    else console.warn(`[qoder-assist] ${message}`);
  }

  async start() {
    await this.store.ensureRoot();
    await this.analyzer.ensureWorkspace();
    await this.store.ensureLoaded();
    await this.scan({ initial: true });
    await this.pollHooks({ initial: true });
    this.timers.push(setInterval(() => this.pollSessions(), POLL_MS));
    this.timers.push(setInterval(() => this.scan().catch(() => {}), SCAN_MS));
    this.timers.push(setInterval(() => this.tickAnalysis().catch(() => {}), ANALYZE_MS));
    this.timers.push(setInterval(() => this.pollHooks().catch(() => {}), HOOKS_MS));
  }

  // ------------------------------------------------------------------ events

  push(event) {
    const record = { seq: this.seq + 1, t: Date.now(), ...event };
    this.seq = record.seq;
    this.events.push(record);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    for (const sink of this.subs) {
      try {
        sink(record);
      } catch {}
    }
    return record;
  }

  stream(fromSeq) {
    const encoder = new TextEncoder();
    const encode = (event) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
    const subs = this.subs;

    return new ReadableStream({
      start(controller) {
        let closed = false;
        const sink = (event) => {
          if (closed) return;
          try {
            controller.enqueue(encode(event));
          } catch {
            closed = true;
            subs.delete(sink);
          }
        };
        controller.enqueue(encoder.encode(`retry: 3000\n\n`));
        for (const event of this.events) if (event.seq > fromSeq) sink(event);
        subs.add(sink);

        const heartbeat = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(': ping\n\n'));
          } catch {
            closed = true;
            subs.delete(sink);
            clearInterval(heartbeat);
          }
        }, 15000);

        this.cleanup = () => {
          closed = true;
          clearInterval(heartbeat);
          subs.delete(sink);
          try {
            controller.close();
          } catch {}
        };
      },
      cancel: () => this.cleanup?.(),
    });
  }

  // ---------------------------------------------------------------- sessions

  async scan({ initial = false } = {}) {
    const list = await scanSessions();
    const next = new Map(list.map((session) => [session.id, session]));
    const added = [];
    for (const session of list) {
      if (!this.metas.has(session.id)) added.push(session);
      this.metas.set(session.id, session);
    }
    for (const id of [...this.metas.keys()]) if (!next.has(id)) this.metas.delete(id);

    const active = list.filter((session) => session.active);
    this.defaultSessionId = (active[0] ?? list[0])?.id ?? null;

    for (const session of active.slice(0, 8)) {
      await this.ensureLoaded(session.id).catch(() => {});
    }

    for (const session of added) this.push({ type: 'session', session: this.describe(session) });
    if (initial) return;
  }

  describe(meta) {
    const runtime = this.runtimes.get(meta.id);
    return {
      id: meta.id,
      title: meta.title,
      project: meta.project,
      projectLabel: meta.projectLabel,
      cwd: meta.cwd,
      size: meta.size,
      mtime: meta.mtime,
      active: meta.active,
      loaded: Boolean(runtime),
      lastOffset: runtime?.lastOffset ?? null,
      messageCount: runtime?.messages.length ?? 0,
    };
  }

  async ensureLoaded(sessionId) {
    const existing = this.runtimes.get(sessionId);
    if (existing) return existing;
    const meta = this.metas.get(sessionId);
    if (!meta) return null;
    const tailer = new Tailer(meta.file);
    const messages = await tailer.init(INITIAL_TAIL_BYTES);
    const runtime = { id: sessionId, tailer, messages: [], seq: 0, lastOffset: tailer.offset };
    for (const message of messages) runtime.messages.push({ ...message, seq: ++runtime.seq });
    this.runtimes.set(sessionId, runtime);
    return runtime;
  }

  runtimeMessages(sessionId) {
    return this.runtimes.get(sessionId)?.messages ?? [];
  }

  async pollSessions() {
    for (const runtime of this.runtimes.values()) {
      let result;
      try {
        result = await runtime.tailer.readNew();
      } catch (error) {
        this.warn(`tail failed: ${error?.message ?? error}`);
        continue;
      }
      if (result.replaced || result.truncated) {
        runtime.messages = [];
        runtime.seq = 0;
        this.push({ type: 'reset', sessionId: runtime.id, reason: result.replaced ? 'replaced' : 'truncated' });
      }
      if (result.messages.length) {
        const added = result.messages.map((message) => ({ ...message, seq: ++runtime.seq }));
        runtime.messages.push(...added);
        if (runtime.messages.length > MAX_MESSAGES) {
          runtime.messages.splice(0, runtime.messages.length - MAX_MESSAGES);
        }
        runtime.lastOffset = runtime.tailer.offset;
        this.push({ type: 'messages', sessionId: runtime.id, messages: added });
        const ended = added.some((message) => message.stopReason && TURN_END.has(message.stopReason));
        if (ended) {
          const meta = this.metas.get(runtime.id);
          if (meta?.active) void this.analyzer.tick({ ...meta, id: runtime.id }, runtime.messages);
        }
      }
      const meta = this.metas.get(runtime.id);
      if (meta) {
        try {
          const stat = await fs.stat(meta.file);
          meta.size = stat.size;
          meta.mtime = stat.mtimeMs;
          meta.active = Date.now() - stat.mtimeMs < 5 * 60 * 1000;
        } catch {}
      }
    }
  }

  async tickAnalysis() {
    for (const meta of this.metas.values()) {
      if (!meta.active) continue;
      const runtime = this.runtimes.get(meta.id);
      if (!runtime?.messages.length) continue;
      await this.analyzer.tick(meta, runtime.messages).catch(() => {});
    }
    await this.finalSummaryCheck();
  }

  async finalSummaryCheck() {
    const now = Date.now();
    for (const [id, runtime] of this.runtimes) {
      const meta = this.metas.get(id);
      if (!meta || !runtime.messages.length) continue;
      if (now - meta.mtime < IDLE_FINAL_MS) continue;
      const record = await this.store.analysis(id);
      const last = runtime.messages.reduce((max, message) => Math.max(max, message.offset), 0);
      if ((record.lastFinalOffset ?? 0) >= last) continue;
      await this.analyzer.maybeFinalSummary({ ...meta, id }, runtime.messages).catch(() => {});
    }
  }

  async messages(sessionId, { before, limit = 200 } = {}) {
    const runtime = await this.ensureLoaded(sessionId);
    if (!runtime) return { messages: [], hasMore: false };
    const meta = this.metas.get(sessionId);
    if (!before || before > runtime.messages[0]?.offset) {
      const list = runtime.messages.slice(-limit);
      const earliest = list[0]?.offset ?? 0;
      return { messages: list, earliest, hasMore: runtime.messages.length > list.length };
    }
    const page = await readRange(meta.file, before, PAGE_BYTES);
    const list = page.messages.slice(-limit).map((message) => ({ ...message, seq: null }));
    return { messages: list, earliest: list[0]?.offset ?? page.earliest, hasMore: Boolean(list.length) };
  }

  async state() {
    const sessions = [...this.metas.values()]
      .sort((a, b) => Number(b.active) - Number(a.active) || b.mtime - a.mtime)
      .map((meta) => this.describe(meta));
    const quota = await this.store.quotaStatus({ hourlyCap: 6, dailyCap: 200 });
    return {
      ok: true,
      cwd: this.cwd,
      sessions,
      defaultSessionId: this.defaultSessionId,
      analyzer: this.analyzer.status(),
      quota,
      assistRoot: assistRoot(),
      seq: this.seq,
    };
  }

  async suggestions(sessionId) {
    return this.store.readSuggestions(sessionId);
  }

  async read(sessionId, offset) {
    await this.store.setReadOffset(sessionId, offset);
    return { ok: true };
  }

  async feedback(sessionId, suggestionId, itemIndex, value) {
    const ok = await this.store.suggestionFeedback(sessionId, suggestionId, itemIndex, value);
    return { ok };
  }

  async summary(sessionId) {
    const meta = this.metas.get(sessionId);
    if (!meta) return { ok: false, error: 'unknown session' };
    return { ok: true, markdown: await this.store.readSummary(meta.project, sessionId) };
  }

  async generateSummary(sessionId, { final = false } = {}) {
    const meta = this.metas.get(sessionId);
    if (!meta) return { ok: false, error: 'unknown session' };
    await this.ensureLoaded(sessionId);
    const runtime = this.runtimes.get(sessionId);
    if (!runtime?.messages.length) return { ok: false, error: '会话没有可分析的消息' };
    const job = final
      ? await this.analyzer.maybeFinalSummary(meta, runtime.messages)
      : await this.analyzer.summarizeNow(meta);
    return job ?? { ok: true, accepted: true };
  }

  async analyze(sessionId) {
    const meta = this.metas.get(sessionId);
    if (!meta) return { ok: false, error: 'unknown session' };
    const runtime = await this.ensureLoaded(sessionId);
    if (!runtime?.messages.length) return { ok: false, error: '会话没有可分析的消息' };
    const result = await this.analyzer.analyzeNow(meta, runtime.messages);
    return { ok: true, ...result };
  }

  // ------------------------------------------------------------------ hooks

  async pollHooks({ initial = false } = {}) {
    if (initial) {
      try {
        const file = path.join(assistRoot(), 'hooks.jsonl');
        const stat = await fs.stat(file);
        this.hookOffset = stat.size;
      } catch {
        this.hookOffset = 0;
      }
      return;
    }
    const { events, offset } = await readHookEvents(this.hookOffset ?? 0);
    this.hookOffset = offset;
    for (const payload of events) {
      const sessionId = payload?.session_id ?? payload?.sessionId;
      if (!sessionId) continue;
      const eventName = payload?.hook_event_name ?? payload?.event;
      if (eventName === 'PermissionRequest') {
        this.push({
          type: 'permission',
          sessionId,
          toolName: payload?.tool_name ?? payload?.tool ?? '',
          message: payload?.message ?? '',
        });
      } else if (eventName === 'SessionStart' || eventName === 'SessionEnd') {
        this.push({ type: 'hook', event: eventName, sessionId });
        if (eventName === 'SessionEnd') {
          const meta = this.metas.get(sessionId);
          const runtime = this.runtimes.get(sessionId);
          if (meta && runtime?.messages.length) {
            void this.analyzer.maybeFinalSummary(meta, runtime.messages).catch(() => {});
          }
        }
      } else if (eventName === 'Stop') {
        const meta = this.metas.get(sessionId);
        const runtime = this.runtimes.get(sessionId);
        if (meta && runtime?.messages.length) {
          void this.analyzer.tick(meta, runtime.messages).catch(() => {});
        }
      }
    }
  }

  async dispose() {
    this.disposed = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    for (const sink of this.subs) {
      try {
        sink({ seq: -1, type: 'bye' });
      } catch {}
    }
    this.subs.clear();
  }
}
