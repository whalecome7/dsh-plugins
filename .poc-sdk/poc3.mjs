// POC Step 3: 用 Write 触发 canUseTool —— 验证宿主侧能否接管写权限
import { qodercliAuth, query, shutdownDaemon } from '@qoder-ai/qoder-agent-sdk';
import fs from 'node:fs';

const t0 = Date.now();
const log = (...a) => console.log(`[${String(Date.now() - t0).padStart(6)}ms]`, ...a);

const TARGET = 'D:/code/dsh-plugins/.poc-sdk/hello.txt';
try { fs.unlinkSync(TARGET); } catch {}
log('清理完成，目标文件存在=', fs.existsSync(TARGET));

const seen = [];
const MODE = process.argv[2] || 'allow'; // allow | deny
log('本次模式 =', MODE);

const q = query({
  prompt: '在当前工作目录创建一个名为 hello.txt 的文件，内容只有一行：SDK 权限测试成功。完成后告诉我你做了什么。',
  options: {
    auth: qodercliAuth(),
    cwd: 'D:/code/dsh-plugins/.poc-sdk',
    permissionMode: 'default',
    maxTurns: 6,
    async canUseTool(toolName, input, opts) {
      const rec = {
        toolName,
        inputPreview: JSON.stringify(input).slice(0, 300),
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

      if (MODE === 'deny') {
        return { behavior: 'deny', message: 'POC: 宿主侧主动拒绝写入。', toolUseID: opts?.toolUseID };
      }
      return { behavior: 'allow', updatedInput: input, toolUseID: opts?.toolUseID };
    },
  },
});

try {
  for await (const m of q) {
    if (m.type === 'assistant') {
      for (const b of m.message?.content ?? []) {
        if (b.type === 'text') log('   text:', JSON.stringify(b.text).slice(0, 200));
        else if (b.type === 'tool_use') log('   tool_use:', b.name, JSON.stringify(b.input).slice(0, 200));
        else log('   block:', b.type);
      }
    }
    if (m.type === 'user' && m.message?.content) {
      for (const b of [].concat(m.message.content)) {
        if (b.type === 'tool_result') log('   tool_result:', JSON.stringify(b).slice(0, 250));
      }
    }
    if (m.type === 'system' && m.subtype === 'permission_denied') log('   PERMISSION_DENIED:', JSON.stringify(m).slice(0, 300));
    if (m.type === 'result') log('   result:', JSON.stringify(m).slice(0, 350));
  }
} catch (e) {
  log('ERROR:', e?.name, e?.message);
  console.error(e);
} finally {
  try { await q.close?.(); } catch {}
  try { await shutdownDaemon?.(); } catch {}
  log('=== SUMMARY ===');
  log('canUseTool 调用次数 =', seen.length);
  log('触发的工具 =', [...new Set(seen.map((s) => s.toolName))].join(', ') || '(无)');
  log('hello.txt 是否存在 =', fs.existsSync(TARGET));
  if (fs.existsSync(TARGET)) log('文件内容 =', JSON.stringify(fs.readFileSync(TARGET, 'utf8')));
}
