/**
 * Incremental conversation analysis on top of the Qoder Agent SDK.
 *
 * - One persistent analyst session per CLI session, resumed so it remembers
 *   earlier context; rebuilt from the rolling summary when it would get too big.
 * - Zero tools and an empty workspace: the analyst can only reason over the
 *   text we hand it, never touch a repository.
 * - Hard quota gates keep a four-terminal day from draining the account.
 */

import { qodercliAuth, query } from '@qoder-ai/qoder-agent-sdk';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ANALYST_MARKER, analystWorkspace, lockFile } from './paths.js';
import { redact } from './redact.js';
import { deltaText, isWriteTool } from './transcript.js';

const DEBOUNCE_MS = 90 * 1000;
const HOURLY_CAP = 6;
const DAILY_CAP = 200;
const QUEUE_LIMIT = 3;
const MAX_PROMPT_CHARS = 60 * 1000;
const MAX_DELTA_CHARS = 12 * 1000;
const MAX_SUMMARY_DIGEST = 20 * 1000;
const SUMMARY_MESSAGE_LIMIT = 80;
const FAILURE_LIMIT = 3;
const FAILURE_COOLDOWN_MS = 10 * 60 * 1000;

const ADVICE_SYSTEM = [
  '你是开发者终端会话的旁观分析者，没有任何工具。',
  '你只能根据给定对话推理，不要臆测未出现的文件或命令。',
  '目标是发现开发者可能忽略的问题：做错的方向、漏掉的验证、风险操作、重复踩坑。',
  '不要给出泛泛而谈的建议，不要复述对话，不要重复已给出的建议。',
  '若没有值得说的内容，输出空数组。',
].join('\n');

const SUMMARY_SYSTEM = [
  '你是开发会话的记录员。输入是一个 qodercli 终端会话的片段，输出中文 markdown 摘要。',
  '结构固定为：一句话结论 / 做了什么 / 关键决策 / 未完成事项。',
  '只写事实，不复述工具原始输出，不写客套话，总长度 400 字以内。',
  '直接输出摘要正文，不要加任何前后缀。',
].join('\n');

function randomId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function parseAdvice(text) {
  const raw = String(text ?? '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '');
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((item) => item && typeof item.title === 'string' && item.title.trim())
    .slice(0, 3)
    .map((item) => ({
      title: String(item.title).trim().slice(0, 120),
      detail: String(item.detail ?? '').trim().slice(0, 400),
      evidence: String(item.evidence ?? '').trim().slice(0, 200),
      feedback: null,
    }));
}

function readOnlyText(text) {
  return String(text ?? '').trim();
}

export class Analyzer {
  constructor({ store, logger, emit }) {
    this.store = store;
    this.logger = logger;
    this.emit = emit ?? (() => {});
    this.queue = [];
    this.running = false;
    this.queuedSessions = new Set();
    this.failures = new Map();
    this.paused = new Map();
    this.lastStatus = null;
    this.disabled = process.env.DSH_QODER_ASSIST_NO_ANALYZE === '1';
  }

  warn(message) {
    if (typeof this.logger?.warn === 'function') this.logger.warn(`[qoder-assist] ${message}`);
    else console.warn(`[qoder-assist] ${message}`);
  }

  status() {
    return {
      running: this.running,
      queued: this.queue.length,
      paused: [...this.paused.entries()].map(([sessionId, value]) => ({ sessionId, reason: value.reason })),
      lastStatus: this.lastStatus,
      disabled: this.disabled,
      caps: { hourly: HOURLY_CAP, daily: DAILY_CAP },
    };
  }

  async ensureWorkspace() {
    await fs.mkdir(analystWorkspace(), { recursive: true });
  }

  /**
   * Cross-process lock: several dsh instances can share this state directory.
   * A stale lock (killed process) expires after five minutes.
   */
  async acquireLock(sessionId) {
    const file = lockFile(sessionId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await fs.open(file, 'wx');
        await handle.writeFile(JSON.stringify({ pid: process.pid, ts: Date.now() }));
        await handle.close();
        return true;
      } catch {
        try {
          const stat = await fs.stat(file);
          if (Date.now() - stat.mtimeMs > 5 * 60 * 1000) {
            await fs.unlink(file);
            continue;
          }
        } catch {}
        return false;
      }
    }
    return false;
  }

  async releaseLock(sessionId) {
    try {
      await fs.unlink(lockFile(sessionId));
    } catch {}
  }

  /** Auto-trigger check for one active session. */
  async tick(session, messages, { force = false } = {}) {
    if (this.disabled) return;
    const paused = this.paused.get(session.id);
    if (paused) {
      if (paused.until > Date.now()) return;
      this.paused.delete(session.id);
    }
    const record = await this.store.analysis(session.id);
    const anchor = record.lastAnalyzedOffset ?? 0;
    const delta = messages.filter((message) => message.offset > anchor);
    const real = delta.filter((message) => !message.meta);
    const writes = delta.some((message) => message.tools.some((tool) => isWriteTool(tool.name)));
    if (!force && real.length < 2 && !writes) return;
    if (!force && record.lastAnalyzedAt && Date.now() - record.lastAnalyzedAt < DEBOUNCE_MS) return;
    await this.enqueue({ type: 'advice', session, trigger: force ? 'manual' : 'auto', force });
  }

  async analyzeNow(session, messages) {
    return this.tick(session, messages, { force: true });
  }

  async maybeFinalSummary(session, messages) {
    if (this.disabled) return;
    const record = await this.store.analysis(session.id);
    const last = messages.reduce((max, message) => Math.max(max, message.offset), 0);
    if (!last || (record.lastFinalOffset ?? 0) >= last) return;
    await this.enqueue({ type: 'summary', session, final: true });
  }

  async summarizeNow(session) {
    if (this.disabled) return { ok: false, reason: 'analysis disabled' };
    await this.enqueue({ type: 'summary', session, final: false, force: true });
  }

  async enqueue(job) {
    if (this.queuedSessions.has(job.session.id)) return { ok: false, reason: 'already queued' };
    if (this.queue.length >= QUEUE_LIMIT) {
      this.setStatus(`队列已满，跳过 ${job.session.id.slice(0, 8)}`);
      return { ok: false, reason: 'queue full' };
    }
    this.queue.push(job);
    this.queuedSessions.add(job.session.id);
    void this.pump();
    return { ok: true, queued: this.queue.length };
  }

  setStatus(message) {
    if (this.lastStatus === message) return;
    this.lastStatus = message;
    this.emit({ type: 'status', message });
  }

  async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift();
        this.queuedSessions.delete(job.session.id);
        try {
          if (job.type === 'advice') await this.runAdvice(job);
          else await this.runSummary(job);
        } catch (error) {
          this.warn(`${job.type} failed: ${error?.message ?? error}`);
          this.noteFailure(job.session, error);
        }
      }
    } finally {
      this.running = false;
      this.emit({ type: 'status', message: null });
    }
  }

  noteFailure(session, error) {
    const count = (this.failures.get(session.id) ?? 0) + 1;
    this.failures.set(session.id, count);
    if (count >= FAILURE_LIMIT) {
      const until = Date.now() + FAILURE_COOLDOWN_MS;
      this.paused.set(session.id, { reason: String(error?.message ?? error).slice(0, 200), until });
      this.failures.delete(session.id);
      this.setStatus('连续失败，分析已暂停 10 分钟');
      this.emit({ type: 'status', message: '连续失败，分析已暂停 10 分钟' });
    }
  }

  async runSdk(prompt, { systemAppend, resume }) {
    await this.ensureWorkspace();
    const options = {
      auth: qodercliAuth(),
      cwd: analystWorkspace(),
      tools: [],
      maxTurns: 1,
      permissionMode: 'default',
      systemPrompt: { type: 'preset', preset: 'qodercli', append: systemAppend },
    };
    if (resume) options.resume = resume;
    if (process.env.DSH_QODER_ASSIST_MODEL) options.model = process.env.DSH_QODER_ASSIST_MODEL;

    const empty = await fs.readdir(analystWorkspace()).catch(() => []);
    if (empty.length) this.warn('analyst workspace is not empty; analysis session may see stray files');

    const q = query({ prompt, options });
    let text = '';
    let sessionId = null;
    try {
      for await (const message of q) {
        if (message?.type === 'system' && message.subtype === 'init') sessionId = message.session_id ?? null;
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
      } catch {}
    }
    return { text: readOnlyText(text), sessionId };
  }

  async runAdvice({ session, trigger, force }) {
    if (!(await this.acquireLock(session.id))) return;
    try {
      await this.runAdviceLocked({ session, trigger, force });
    } finally {
      await this.releaseLock(session.id);
    }
  }

  async runAdviceLocked({ session, trigger, force }) {
    const record = await this.store.analysis(session.id);
    // Another dsh instance may have just finished while we waited for the lock.
    if (!force && record.lastAnalyzedAt && Date.now() - record.lastAnalyzedAt < DEBOUNCE_MS) return;

    const quota = await this.store.takeQuota(session.id, {
      hourlyCap: HOURLY_CAP,
      dailyCap: DAILY_CAP,
      force,
    });
    if (!quota.ok) {
      this.setStatus(`分析暂停：${quota.reason}`);
      return;
    }

    const messages = this.messagesFor(session);
    const anchor = record.lastAnalyzedOffset ?? 0;
    const delta = messages.filter((message) => message.offset > anchor);
    if (!delta.length) return;

    const summary = await this.store.readSummary(session.project, session.id);
    const previous = (await this.store.readSuggestions(session.id)).slice(-2);
    const previousTitles = previous.flatMap((batch) => (batch.items ?? []).map((item) => item.title));

    const body = [
      `${ANALYST_MARKER}`,
      '你是旁观分析者。下面是 qodercli 终端里正在进行的开发会话。',
      `项目：${session.cwd || session.project}`,
      '',
      '## 已有摘要',
      summary ? summary.slice(0, 4000) : '（无）',
      '',
      '## 已给出的建议（不要重复）',
      previousTitles.length ? previousTitles.map((title) => `- ${title}`).join('\n') : '（无）',
      '',
      '## 新增对话',
      deltaText(delta, MAX_DELTA_CHARS),
      '',
      '请输出严格 JSON 数组（1~3 项），每项形如：',
      '{"title":"一句话结论","detail":"为什么/怎么改","evidence":"消息#偏移 或 工具名"}',
      '没有值得说的就输出 []。不要输出 JSON 以外的任何文字。',
    ].join('\n');

    const prompt = redact(body);
    const resume = prompt.length < MAX_PROMPT_CHARS ? record.analystSessionId ?? undefined : undefined;
    const { text, sessionId } = await this.runSdk(prompt, {
      systemAppend: ADVICE_SYSTEM,
      resume,
    });

    const items = parseAdvice(text);
    const lastOffset = delta.reduce((max, message) => Math.max(max, message.offset), anchor);
    await this.store.updateAnalysis(session.id, {
      analystSessionId: sessionId ?? (resume ? record.analystSessionId : null),
      lastAnalyzedOffset: lastOffset,
      lastAnalyzedAt: Date.now(),
      lastTrigger: trigger,
    });
    this.failures.delete(session.id);
    this.paused.delete(session.id);

    if (!items.length) {
      this.setStatus('本轮没有值得提醒的内容');
      return;
    }

    const suggestion = {
      id: randomId('sg'),
      ts: Date.now(),
      sessionId: session.id,
      anchorOffset: lastOffset,
      trigger,
      items,
    };
    await this.store.appendSuggestion(session.id, suggestion);
    this.emit({ type: 'suggestion', sessionId: session.id, suggestion });
    this.setStatus(null);
  }

  async runSummary(job) {
    if (!(await this.acquireLock(job.session.id))) return;
    try {
      await this.runSummaryLocked(job);
    } finally {
      await this.releaseLock(job.session.id);
    }
  }

  async runSummaryLocked({ session, final, force }) {
    const quota = await this.store.takeQuota(session.id, {
      hourlyCap: HOURLY_CAP,
      dailyCap: DAILY_CAP,
      force: Boolean(force && !final),
      ignoreHourly: final,
    });
    if (!quota.ok) {
      this.setStatus(`摘要暂停：${quota.reason}`);
      return;
    }

    const messages = this.messagesFor(session)
      .filter((message) => !message.meta)
      .slice(-SUMMARY_MESSAGE_LIMIT);
    if (!messages.length) return;

    const previous = await this.store.readSummary(session.project, session.id);
    const prompt = redact(
      [
        '请基于以下终端会话更新摘要。',
        '',
        '## 已有摘要',
        previous ? previous.slice(0, 4000) : '（无，这是首次生成）',
        '',
        '## 会话片段',
        deltaText(messages, MAX_SUMMARY_DIGEST),
        '',
        '请输出更新后的摘要正文。',
      ].join('\n'),
    );

    const { text } = await this.runSdk(prompt, { systemAppend: SUMMARY_SYSTEM });
    if (!text) return;

    await this.store.writeSummary(session.project, session, text);
    if (final) {
      const last = messages.reduce((max, message) => Math.max(max, message.offset), 0);
      await this.store.updateAnalysis(session.id, { lastFinalOffset: last, lastFinalAt: Date.now() });
    }
    this.failures.delete(session.id);
    this.emit({ type: 'summary', sessionId: session.id, final, markdown: text });
    this.setStatus(null);
  }

  /** Filled in by the hub so jobs can read the freshest message list. */
  messagesFor(session) {
    return this.messageSource ? this.messageSource(session) : [];
  }
}
