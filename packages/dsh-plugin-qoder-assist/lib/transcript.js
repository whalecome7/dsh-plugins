/**
 * Turn raw qodercli JSONL records into compact, UI-friendly messages.
 *
 * The transcript mixes real conversation with machine bookkeeping
 * (`active-leaf`, `runtime-config`, synthetic skill prompts...). Only user and
 * assistant records survive; everything else is dropped here rather than in the
 * scanner so both the UI and the analyser see the same shape.
 */

export const TURN_END = new Set(['end_turn', 'stop_sequence', 'max_tokens']);

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const META_USER_PREFIXES = [
  '<local-command-caveat>',
  '<local-command-stdout>',
  '<command-message>',
  '<command-name>',
  '<system-reminder>',
  'Caveat: The messages below were generated',
  'Base directory for this skill:',
];

const MAX_TOOL_INPUT = 2000;
const MAX_TOOL_RESULT = 4000;

export function isMetaUserText(text) {
  const value = String(text ?? '').trimStart();
  return META_USER_PREFIXES.some((prefix) => value.startsWith(prefix));
}

export function isWriteTool(name) {
  return WRITE_TOOLS.has(name);
}

function blocksOf(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

function cap(value, limit) {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}…[+${text.length - limit}]` : text;
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? '');
  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      if (block?.type === 'text') return block.text ?? '';
      if (block?.type === 'image') return '[image]';
      return JSON.stringify(block);
    })
    .join('\n');
}

/**
 * Normalise one transcript record.
 *
 * @returns {null | {
 *   offset: number, ts: number|null, role: 'user'|'assistant',
 *   text: string, thinking: string, meta: boolean,
 *   tools: {id: string, name: string, input: unknown}[],
 *   toolResults: {toolUseId: string, isError: boolean, text: string}[],
 *   stopReason: string|null
 * }}
 */
export function parseRecord(record, offset) {
  if (!record || (record.type !== 'user' && record.type !== 'assistant')) return null;
  const message = record.message ?? {};
  const blocks = blocksOf(message.content);
  const out = {
    offset,
    ts: Date.parse(record.timestamp) || null,
    role: record.type,
    text: '',
    thinking: '',
    meta: false,
    tools: [],
    toolResults: [],
    stopReason: message.stop_reason ?? null,
  };

  for (const block of blocks) {
    if (block?.type === 'text' && block.text) out.text += block.text;
    else if (block?.type === 'thinking') out.thinking += block.thinking ?? block.text ?? '';
    else if (block?.type === 'tool_use') {
      out.tools.push({
        id: block.id ?? '',
        name: block.name ?? '?',
        input: cap(JSON.stringify(block.input ?? {}), MAX_TOOL_INPUT),
      });
    } else if (block?.type === 'tool_result') {
      out.toolResults.push({
        toolUseId: block.tool_use_id ?? '',
        isError: Boolean(block.is_error),
        text: cap(toolResultText(block.content), MAX_TOOL_RESULT),
      });
    }
  }

  if (out.role === 'user' && !out.toolResults.length) out.meta = isMetaUserText(out.text);
  if (!out.text && !out.thinking && !out.tools.length && !out.toolResults.length) return null;
  return out;
}

export function aiTitle(record) {
  return record?.type === 'ai-title' ? record.aiTitle ?? null : null;
}

function describeToolInput(raw) {
  try {
    const input = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!input || typeof input !== 'object') return '';
    const command = input.command ?? input.cmd;
    if (command) return String(command).slice(0, 160);
    const file = input.file_path ?? input.filePath ?? input.path ?? input.notebook_path;
    if (file) return String(file);
    if (input.pattern) return String(input.pattern).slice(0, 120);
    if (input.url) return String(input.url).slice(0, 120);
  } catch {
    return '';
  }
  return '';
}

/** Render one message for the analysis prompt. Meta records are skipped. */
export function messageForPrompt(message) {
  const lines = [];
  if (message.role === 'user') {
    if (message.meta) return '';
    if (message.text) lines.push(`[#${message.offset}] 用户：${cap(message.text, 1400)}`);
  } else {
    if (message.text) lines.push(`[#${message.offset}] 助手：${cap(message.text, 1400)}`);
    for (const tool of message.tools) {
      const detail = describeToolInput(tool.input);
      lines.push(`[#${message.offset}] 工具 ${tool.name}${detail ? `：${detail}` : ''}`);
    }
  }
  for (const result of message.toolResults) {
    if (result.isError) lines.push(`[#${message.offset}] 工具失败：${cap(result.text, 500)}`);
  }
  return lines.join('\n');
}

/** Concatenate messages into a prompt-sized digest, keeping the newest part. */
export function deltaText(messages, maxChars) {
  const blocks = [];
  for (const message of messages) {
    const block = messageForPrompt(message);
    if (block) blocks.push(block);
  }
  let out = blocks.join('\n');
  if (out.length <= maxChars) return out;
  out = out.slice(out.length - maxChars);
  const firstNewline = out.indexOf('\n');
  return `（较早内容已截断）\n${firstNewline >= 0 ? out.slice(firstNewline + 1) : out}`;
}

export function describeToolInputForUi(name, raw) {
  const detail = describeToolInput(raw);
  return detail ? `${name}: ${detail}` : name;
}
