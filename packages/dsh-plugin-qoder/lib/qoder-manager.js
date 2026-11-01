/**
 * Qoder session manager.
 *
 * Owns the bridge between the dsh panel and `@qoder-ai/qoder-agent-sdk`:
 *
 *  - one panel session == one Qoder CLI session, resumed across process restarts
 *    via `options.resume`, so the conversation lives on Qoder's side (decision B)
 *  - every SDK message is normalised into a flat, monotonic event log that the
 *    browser tails over SSE — reconnects replay from a sequence number, so a
 *    dropped stream never loses events
 *  - `canUseTool` is turned into a browser-side approval card; the SDK call is
 *    held open until the user answers, which is why `permissionMode` can stay at
 *    `default` instead of `bypassPermissions`
 */

import { qodercliAuth, query, shutdownDaemon } from '@qoder-ai/qoder-agent-sdk';
import { diff as gitDiff, head as gitHead, status as gitStatus } from './git-tools.js';
import { SummaryStore } from './summary.js';

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_EVENTS_PER_SESSION = 6000;
const MAX_TURNS = 500;

function newSessionId() {
  return `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Flatten a `tool_result` content payload into readable text. */
function flattenToolResult(content) {
  if (typeof content === 'string') return content.slice(0, 1200);
  if (!Array.isArray(content)) return JSON.stringify(content ?? '').slice(0, 1200);
  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      if (block?.type === 'text') return block.text ?? '';
      if (block?.type === 'image') return '[image]';
      return JSON.stringify(block).slice(0, 300);
    })
    .join('\n')
    .slice(0, 1200);
}

/** One-line description of a tool call, for the summary and the collapsed card. */
function describeTool(name, input) {
  if (!input || typeof input !== 'object') return `${name}`;
  const path =
    input.file_path ?? input.filePath ?? input.path ?? input.notebook_path ?? input.target_file ?? undefined;
  const command = input.command ?? input.cmd;
  if (command) return `${name}: ${String(command).slice(0, 160)}`;
  if (path) return `${name}: ${path}`;
  if (input.pattern) return `${name}: ${String(input.pattern).slice(0, 120)}`;
  if (input.url) return `${name}: ${String(input.url).slice(0, 120)}`;
  return name;
}

export class QoderManager {
  constructor({ cwd, logger }) {
    this.cwd = cwd;
    this.logger = logger;
    this.sessions = new Map();
    this.approvalSeq = 0;
    this.summaryModel = process.env.DSH_QODER_SUMMARY_MODEL || 'Efficient';
    this.summaries = new SummaryStore({
      cwd,
      logger,
      runSummarize: (prompt, systemPrompt) => this.runSummarize(prompt, systemPrompt),
    });
    this.disposed = false;
  }

  /** Log through the host logger when it exposes `warn`, else fall back to console. */
  warn(message) {
    if (typeof this.logger?.warn === 'function') this.logger.warn(message);
    else console.warn(message);
  }

  // ---------------------------------------------------------------- sessions

  create(title) {
    const session = {
      id: newSessionId(),
      title: title || `Qoder ${this.sessions.size + 1}`,
      createdAt: Date.now(),
      status: 'idle',
      qoderSessionId: null,
      events: [],
      seq: 0,
      subs: new Set(),
      pending: new Map(),
      inbox: [],
      inputClosed: false,
      wake: null,
      query: null,
      turns: 0,
      credits: 0,
      lastDiff: null,
      baseSha: '',
      guardPassed: false,
      turn: null,
      lastError: null,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  ensure(id) {
    if (!id) return this.create();
    return this.sessions.get(id) ?? this.create();
  }

  get(id) {
    return this.sessions.get(id) ?? null;
  }

  list() {
    return [...this.sessions.values()].map((session) => ({
      id: session.id,
      title: session.title,
      status: session.status,
      createdAt: session.createdAt,
      turns: session.turns,
      credits: Number(session.credits.toFixed(6)),
      qoderSessionId: session.qoderSessionId,
      eventCount: session.seq,
      lastError: session.lastError,
    }));
  }

  // ------------------------------------------------------------- event log

  push(session, event) {
    const record = { seq: session.seq + 1, t: Date.now(), ...event };
    session.seq = record.seq;
    session.events.push(record);
    if (session.events.length > MAX_EVENTS_PER_SESSION) {
      session.events.splice(0, session.events.length - MAX_EVENTS_PER_SESSION);
    }
    for (const sink of session.subs) {
      try {
        sink(record);
      } catch {
        /* a dead sink is removed by its own cancel handler */
      }
    }
    return record;
  }

  /**
   * Tail a session's event log as a Server-Sent Events stream.
   *
   * Verified against dsh's Fetch bridge: it iterates `response.body` and writes
   * each chunk with backpressure, so SSE really streams instead of buffering.
   */
  stream(session, fromSeq) {
    const encoder = new TextEncoder();
    const encode = (event) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);

    return new ReadableStream({
      start(controller) {
        let closed = false;
        const sink = (event) => {
          if (closed) return;
          try {
            controller.enqueue(encode(event));
          } catch {
            closed = true;
            session.subs.delete(sink);
          }
        };

        controller.enqueue(encoder.encode(`retry: 3000\n\n`));
        for (const event of session.events) {
          if (event.seq > fromSeq) sink(event);
        }
        session.subs.add(sink);

        const heartbeat = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(': ping\n\n'));
          } catch {
            closed = true;
            session.subs.delete(sink);
            clearInterval(heartbeat);
          }
        }, 15000);

        this.cleanup = () => {
          closed = true;
          clearInterval(heartbeat);
          session.subs.delete(sink);
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
      },
      cancel: () => {
        this.cleanup?.();
      },
    });
  }

  // ------------------------------------------------------------------- send

  /**
   * Start one user turn.
   *
   * @returns {Promise<{sessionId: string, accepted: boolean, needsConfirm?: boolean, entries?: unknown[], reason?: string}>}
   */
  async send(session, prompt, options = {}) {
    const text = String(prompt ?? '').trim();
    if (!text) return { sessionId: session.id, accepted: false, reason: 'empty prompt' };

    if (session.status === 'running' && !options.queue) {
      return { sessionId: session.id, accepted: false, reason: 'busy' };
    }

    // Guard once per session: everything a task changes must be revertible with
    // `git checkout .`, so refuse to start on an already-dirty tree.
    if (!session.guardPassed) {
      const state = await gitStatus(this.cwd);
      if (state.isRepo && !state.clean && !options.force) {
        return { sessionId: session.id, accepted: false, needsConfirm: true, entries: state.entries };
      }
      const head = await gitHead(this.cwd);
      session.baseSha = head?.sha ?? '';
      session.guardPassed = true;
    }

    session.turn = { userText: text, assistantText: '', toolLines: [] };
    session.status = 'running';
    session.lastError = null;

    this.push(session, { type: 'user', text });
    this.push(session, { type: 'status', status: 'running' });

    session.inbox.push(text);
    if (session.wake) {
      const wake = session.wake;
      session.wake = null;
      wake();
    }

    await this.ensureQuery(session, options.model);

    return { sessionId: session.id, accepted: true };
  }

  /** Lazily create (or revive) the underlying Qoder query. */
  async ensureQuery(session, model) {
    if (session.query) return;

    session.inputClosed = false;
    session.initSeen = false;
    const input = this.createInput(session);

    const queryOptions = {
      auth: qodercliAuth(),
      cwd: this.cwd,
      permissionMode: 'default',
      maxTurns: MAX_TURNS,
      canUseTool: (toolName, toolInput, approvalOptions) =>
        this.requestApproval(session, toolName, toolInput, approvalOptions),
    };
    if (model) queryOptions.model = model;
    if (session.qoderSessionId) queryOptions.resume = session.qoderSessionId;

    let q;
    try {
      q = query({ prompt: input, options: queryOptions });
    } catch (error) {
      session.status = 'error';
      session.lastError = String(error?.message ?? error);
      this.push(session, { type: 'error', message: session.lastError });
      this.push(session, { type: 'status', status: 'error' });
      return;
    }

    session.query = q;
    this.pump(session, q);
  }

  /** Async iterable the SDK pulls user messages from, one per turn. */
  createInput(session) {
    const self = this;
    return (async function* input() {
      while (true) {
        if (session.inbox.length > 0) {
          const text = session.inbox.shift();
          yield {
            type: 'user',
            message: { role: 'user', content: [{ type: 'text', text }] },
            parent_tool_use_id: null,
          };
          continue;
        }
        if (session.inputClosed || self.disposed) return;
        await new Promise((resolve) => {
          session.wake = resolve;
        });
      }
    })();
  }

  /** Drain one live query until it ends, then clear the slot. */
  async pump(session, q) {
    try {
      for await (const message of q) {
        this.handleMessage(session, message);
      }
    } catch (error) {
      const messageText = String(error?.message ?? error);
      // An aborted turn surfaces as an error; do not paint the session red.
      if (!/abort/i.test(messageText)) {
        session.lastError = messageText;
        this.push(session, { type: 'error', message: messageText });
      }
    } finally {
      if (session.query === q) session.query = null;
      for (const [approvalId, pending] of session.pending) {
        pending.resolve({ behavior: 'deny', message: '会话已结束。', toolUseID: pending.toolUseID });
        clearTimeout(pending.timer);
        session.pending.delete(approvalId);
      }
      if (session.status !== 'error') this.finishTurn(session, null);
    }
  }

  handleMessage(session, message) {
    if (message?.type === 'system') {
      if (message.subtype === 'init') {
        if (message.session_id) session.qoderSessionId = message.session_id;
        // The SDK forwards the CLI's init frame once per transport hop, so the
        // same handshake can arrive twice; keep only the first in the event log.
        if (!session.initSeen) {
          session.initSeen = true;
          this.push(session, {
            type: 'init',
            sessionId: message.session_id ?? null,
            model: message.model ?? null,
          });
        }
      } else if (message.subtype === 'permission_denied') {
        this.push(session, { type: 'notice', level: 'warn', text: '一次工具调用被拒绝。' });
      }
      return;
    }

    if (message?.type === 'assistant') {
      for (const block of message.message?.content ?? []) {
        if (block?.type === 'text' && block.text) {
          if (session.turn) session.turn.assistantText += `${block.text}\n`;
          this.push(session, { type: 'assistant_text', text: block.text });
        } else if (block?.type === 'thinking') {
          this.push(session, { type: 'thinking', text: block.thinking ?? block.text ?? '' });
        } else if (block?.type === 'tool_use') {
          if (session.turn) session.turn.toolLines.push(describeTool(block.name, block.input));
          this.push(session, { type: 'tool_use', id: block.id, name: block.name, input: block.input ?? null });
        }
      }
      return;
    }

    if (message?.type === 'user') {
      for (const block of [].concat(message.message?.content ?? [])) {
        if (block?.type === 'tool_result') {
          this.push(session, {
            type: 'tool_result',
            id: block.tool_use_id,
            isError: Boolean(block.is_error),
            text: flattenToolResult(block.content),
          });
        }
      }
      return;
    }

    if (message?.type === 'result') {
      const credits = Number(message.total_credits ?? message.total_cost_usd ?? 0) || 0;
      session.credits += credits;
      session.turns += 1;
      if (message.session_id) session.qoderSessionId = message.session_id;
      this.push(session, {
        type: 'turn_end',
        ok: !message.is_error,
        subtype: message.subtype ?? null,
        text: typeof message.result === 'string' ? message.result : '',
        credits,
        durationMs: message.duration_ms ?? null,
        usage: message.usage
          ? {
              input: message.usage.input_tokens ?? 0,
              output: message.usage.output_tokens ?? 0,
              cacheRead: message.usage.cache_read_input_tokens ?? 0,
            }
          : null,
      });
      this.finishTurn(session, message);
    }
  }

  /**
   * Close out a finished turn: snapshot the diff, fold the turn into the rolling
   * summary. Both are best-effort and never rethrow.
   */
  finishTurn(session, resultMessage) {
    const turn = session.turn;
    session.turn = null;
    session.status = 'idle';
    this.push(session, { type: 'status', status: 'idle' });

    const credits = Number(resultMessage?.total_credits ?? resultMessage?.total_cost_usd ?? 0) || 0;

    void this.captureDiff(session).then((snapshot) => {
      if (snapshot) this.push(session, { type: 'diff_ready', summary: snapshot });
    });

    if (!turn) return;
    const hasContent = turn.assistantText.trim().length > 0 || turn.toolLines.length > 0;
    if (!hasContent) return;

    void this.summaries
      .appendTurn({
        sessionId: session.id,
        title: session.title,
        userText: turn.userText,
        assistantText: turn.assistantText.trim(),
        toolLines: turn.toolLines,
        credits,
      })
      .then((summary) => {
        if (summary) this.push(session, { type: 'summary', text: summary });
      });
  }

  async captureDiff(session) {
    try {
      const snapshot = await gitDiff(this.cwd);
      session.lastDiff = snapshot;
      return {
        isRepo: snapshot.isRepo,
        files: snapshot.files.length,
        untracked: snapshot.untracked.length,
        additions: snapshot.files.reduce((total, file) => total + file.additions, 0),
        deletions: snapshot.files.reduce((total, file) => total + file.deletions, 0),
      };
    } catch (error) {
      this.warn(`[qoder] diff capture failed: ${error?.message ?? error}`);
      return null;
    }
  }

  // --------------------------------------------------------------- approval

  requestApproval(session, toolName, toolInput, options) {
    const approvalId = `ap_${++this.approvalSeq}`;
    return new Promise((resolve) => {
      const settle = (result, label) => {
        const pending = session.pending.get(approvalId);
        if (!pending) return;
        clearTimeout(pending.timer);
        session.pending.delete(approvalId);
        this.push(session, { type: 'approval_resolved', approvalId, behavior: result.behavior, label });
        resolve(result);
      };

      const timer = setTimeout(() => {
        settle(
          { behavior: 'deny', message: '审批超时（5 分钟无响应），已自动拒绝。', toolUseID: options?.toolUseID },
          'timeout',
        );
      }, APPROVAL_TIMEOUT_MS);

      session.pending.set(approvalId, { resolve: (result) => settle(result, result.behavior), timer, toolUseID: options?.toolUseID, input: toolInput });

      options?.signal?.addEventListener?.(
        'abort',
        () => settle({ behavior: 'deny', message: '用户已取消。', toolUseID: options?.toolUseID }, 'aborted'),
        { once: true },
      );

      this.push(session, {
        type: 'approval_request',
        approvalId,
        toolName,
        title: options?.title ?? toolName,
        description: options?.description ?? '',
        blockedPath: options?.blockedPath ?? null,
        input: toolInput ?? null,
        suggestions: options?.permissionOptions?.map((option) => option.label ?? option.name) ?? [],
      });
    });
  }

  approve(session, approvalId, behavior, message) {
    const pending = session.pending.get(approvalId);
    if (!pending) return { ok: false, reason: 'not pending' };

    const result =
      behavior === 'allow'
        ? { behavior: 'allow', updatedInput: pending.input ?? {}, toolUseID: pending.toolUseID }
        : { behavior: 'deny', message: message || '用户在面板中拒绝了该操作。', toolUseID: pending.toolUseID };

    pending.resolve(result);
    return { ok: true };
  }

  // ------------------------------------------------------------------ abort

  async abort(session) {
    try {
      await session.query?.interrupt?.();
    } catch (error) {
      this.warn(`[qoder] interrupt failed: ${error?.message ?? error}`);
    }
    for (const [approvalId, pending] of session.pending) {
      pending.resolve({ behavior: 'deny', message: '用户已中断任务。', toolUseID: pending.toolUseID });
      clearTimeout(pending.timer);
      session.pending.delete(approvalId);
    }
    return { ok: true };
  }

  /** End the Qoder CLI session entirely and drop the panel session state. */
  async close(session) {
    session.inputClosed = true;
    if (session.wake) {
      const wake = session.wake;
      session.wake = null;
      wake();
    }
    try {
      await session.query?.close?.();
    } catch {
      /* already gone */
    }
    session.query = null;
    this.sessions.delete(session.id);
    return { ok: true };
  }

  // ---------------------------------------------------------------- summary

  /** One-shot cheap-tier call used by the rolling summarizer. */
  async runSummarize(prompt, systemPrompt) {
    const q = query({
      prompt,
      options: {
        auth: qodercliAuth(),
        cwd: this.cwd,
        model: this.summaryModel,
        maxTurns: 1,
        tools: [],
        // Daemon queries reject `dontAsk`; `default` is fine here because the
        // summary prompt has no tools to approve.
        permissionMode: 'default',
        systemPrompt: { type: 'preset', preset: 'qodercli', append: systemPrompt },
      },
    });

    let text = '';
    try {
      for await (const message of q) {
        if (message?.type === 'assistant') {
          for (const block of message.message?.content ?? []) {
            if (block?.type === 'text' && block.text) text += block.text;
          }
        } else if (message?.type === 'result' && !text && typeof message.result === 'string') {
          text = message.result;
        }
      }
    } finally {
      try {
        await q.close?.();
      } catch {
        /* ignore */
      }
    }
    return text;
  }

  async readSummary(session) {
    return this.summaries.read(session.id);
  }

  async dispose() {
    this.disposed = true;
    for (const session of [...this.sessions.values()]) {
      session.inputClosed = true;
      if (session.wake) session.wake();
      try {
        await session.query?.close?.();
      } catch {
        /* ignore */
      }
    }
    this.sessions.clear();
    try {
      await shutdownDaemon();
    } catch (error) {
      this.warn(`[qoder] shutdownDaemon failed: ${error?.message ?? error}`);
    }
  }
}
