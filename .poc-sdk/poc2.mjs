// POC Step 2: canUseTool 权限回调 —— 验证能否在宿主侧接管工具审批
import { qodercliAuth, query, shutdownDaemon } from '@qoder-ai/qoder-agent-sdk';

const t0 = Date.now();
const log = (...a) => console.log(`[${String(Date.now() - t0).padStart(6)}ms]`, ...a);

const seen = [];

const q = query({
  prompt: '读取当前目录的 package.json，告诉我它依赖了哪些包。只做这件事。',
  options: {
    auth: qodercliAuth(),
    cwd: 'D:/code/dsh-plugins/.poc-sdk',
    permissionMode: 'default',
    maxTurns: 6,
    async canUseTool(toolName, input, opts) {
      const rec = {
        toolName,
        input: JSON.stringify(input).slice(0, 200),
        toolUseID: opts?.toolUseID,
        title: opts?.title,
        displayName: opts?.displayName,
        description: opts?.description,
        blockedPath: opts?.blockedPath,
        decisionReason: opts?.decisionReason,
        hasSignal: !!opts?.signal,
        suggestions: opts?.suggestions?.length ?? 0,
      };
      seen.push(rec);
      log('>>> canUseTool CALLED');
      console.log(JSON.stringify(rec, null, 2));
      // 全部放行，验证 allow 路径
      return { behavior: 'allow', updatedInput: input, toolUseID: opts?.toolUseID };
    },
  },
});

const events = [];
try {
  for await (const m of q) {
    events.push(m.type + (m.subtype ? ':' + m.subtype : ''));
    if (m.type === 'assistant') {
      for (const b of m.message?.content ?? []) {
        if (b.type === 'text') log('   text:', JSON.stringify(b.text).slice(0, 200));
        else if (b.type === 'tool_use') log('   tool_use:', b.name, JSON.stringify(b.input).slice(0, 150));
        else log('   block:', b.type);
      }
    }
    if (m.type === 'user' && m.message?.content) {
      for (const b of [].concat(m.message.content)) {
        if (b.type === 'tool_result') log('   tool_result:', JSON.stringify(b).slice(0, 200));
      }
    }
    if (m.type === 'result') log('   result:', JSON.stringify(m).slice(0, 400));
    if (m.type === 'system' && m.subtype === 'permission_denied') log('   PERMISSION_DENIED:', JSON.stringify(m).slice(0, 300));
  }
} catch (e) {
  log('ERROR:', e?.name, e?.message);
  console.error(e);
} finally {
  try { await q.close?.(); } catch {}
  try { await shutdownDaemon?.(); } catch {}
  log('=== SUMMARY ===');
  log('canUseTool 调用次数 =', seen.length);
  log('工具名 =', [...new Set(seen.map((s) => s.toolName))].join(', '));
  log('事件类型 =', [...new Set(events)].join(', '));
}
