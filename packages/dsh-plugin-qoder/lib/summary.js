/**
 * Rolling summary.
 *
 * After every finished turn the panel asks a cheap model tier to fold the new
 * turn into a running summary — "previous summary + this turn" in, one updated
 * summary out. Cost per turn therefore stays flat instead of growing with the
 * conversation length, unlike a full re-summarize.
 *
 * The markdown file is the deliverable: it is meant to be re-read later, which
 * is exactly why it lives on disk rather than only in the panel.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { summariesDir } from './paths.js';

const SYSTEM_PROMPT = [
  '你是一个开发会话的记录员。你会拿到「已有摘要」和「本轮新增对话」，需要输出更新后的摘要。',
  '要求：',
  '1. 保留已有摘要中仍然有效的信息，把本轮的新事实合并进去，不要丢弃历史结论。',
  '2. 用中文，markdown 格式，结构为：一句话结论 / 做了什么 / 关键决策 / 未完成事项。',
  '3. 只写事实，不要复述工具的原始输出，不要写客套话。',
  '4. 总长度控制在 400 字以内。',
  '5. 直接输出摘要正文，不要加任何前后缀说明。',
].join('\n');

function timestampLabel(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function readIfExists(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

/** Pull the previous summary body back out of the markdown file. */
function extractSummary(markdown) {
  if (!markdown) return '';
  const match = markdown.match(/## 当前摘要\n+([\s\S]*?)\n+## /);
  return match ? match[1].trim() : '';
}

/** Count existing turn headings so numbering continues across process restarts. */
function countTurns(markdown) {
  if (!markdown) return 0;
  return (markdown.match(/^### 第 \d+ 轮/gm) ?? []).length;
}

export class SummaryStore {
  constructor({ cwd, logger, runSummarize }) {
    this.cwd = cwd;
    this.logger = logger;
    this.runSummarize = runSummarize;
    this.busy = new Set();
  }

  file(sessionId) {
    return path.join(summariesDir(this.cwd), `${sessionId}.md`);
  }

  async read(sessionId) {
    return (await readIfExists(this.file(sessionId))) ?? '';
  }

  /**
   * Fold one finished turn into the session summary.
   *
   * Never throws: a summary failure must not break the conversation.
   *
   * @returns {Promise<string|null>} the updated summary body, or null when skipped
   */
  async appendTurn({ sessionId, title, userText, assistantText, toolLines, credits }) {
    if (this.busy.has(sessionId)) return null;
    this.busy.add(sessionId);

    try {
      const filePath = this.file(sessionId);
      const existing = await readIfExists(filePath);
      const previousSummary = extractSummary(existing);
      const turnIndex = countTurns(existing) + 1;

      const digest = [
        `用户：${userText}`,
        toolLines.length > 0 ? `工具动作：\n${toolLines.map((line) => `- ${line}`).join('\n')}` : '',
        `模型回复：${assistantText}`,
      ]
        .filter(Boolean)
        .join('\n\n');

      const prompt = [
        previousSummary ? `已有摘要：\n${previousSummary}` : '已有摘要：（这是第一轮，还没有摘要）',
        `本轮新增对话：\n${digest}`,
        '请输出更新后的摘要。',
      ].join('\n\n');

      const summary = await this.runSummarize(prompt, SYSTEM_PROMPT);
      const body = summary?.trim();
      if (!body) return null;

      const turnBlock = [
        `### 第 ${turnIndex} 轮 · ${timestampLabel()}`,
        '',
        `- 用户：${userText.replace(/\s+/g, ' ').slice(0, 200)}`,
        toolLines.length > 0 ? `- 工具：${toolLines.slice(0, 12).join('；').slice(0, 400)}` : '',
        `- 回复：${assistantText.replace(/\s+/g, ' ').slice(0, 300)}`,
        typeof credits === 'number' ? `- credits：${credits}` : '',
        '',
      ]
        .filter((line) => line !== '')
        .join('\n');

      const keptTurns = existing ? existing.split('## 轮次记录')[1]?.trim() ?? '' : '';

      const markdown = [
        `# Qoder 会话摘要 · ${sessionId}`,
        '',
        `- 会话：${title || '（未命名）'}`,
        `- 更新：${timestampLabel()}`,
        `- 轮次：${turnIndex}`,
        '',
        '## 当前摘要',
        '',
        body,
        '',
        '## 轮次记录',
        '',
        keptTurns,
        turnBlock,
      ].join('\n');

      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, markdown, 'utf8');
      return body;
    } catch (error) {
      console.warn(`[qoder] summary failed: ${error?.message ?? error}`);
      return null;
    } finally {
      this.busy.delete(sessionId);
    }
  }
}
