// POC Step 1: 最小 query —— 验证认证、事件流、结束行为
import { qodercliAuth, query, shutdownDaemon } from '@qoder-ai/qoder-agent-sdk';

const t0 = Date.now();
const log = (...a) => console.log(`[${String(Date.now() - t0).padStart(6)}ms]`, ...a);

log('step1 start');
const q = query({
  prompt: '只回答两个字：你好',
  options: {
    auth: qodercliAuth(),
    cwd: 'D:/code/dsh-plugins/.poc-sdk',
    maxTurns: 1,
  },
});

let count = 0;
const types = new Set();

try {
  for await (const m of q) {
    count++;
    types.add(m.type + (m.subtype ? ':' + m.subtype : ''));
    log(`msg#${count} type=${m.type}${m.subtype ? ' subtype=' + m.subtype : ''}`);

    if (m.type === 'assistant') {
      for (const b of m.message?.content ?? []) {
        if (b.type === 'text') log('   text:', JSON.stringify(b.text).slice(0, 150));
        else log('   block:', b.type, JSON.stringify(b).slice(0, 150));
      }
    }
    if (m.type === 'result') {
      log('   result:', JSON.stringify(m).slice(0, 500));
    }
  }
} catch (e) {
  log('ERROR:', e?.name, e?.message);
  console.error(e);
} finally {
  try { await q.close?.(); } catch (e) { log('close err', e?.message); }
  try { await shutdownDaemon?.(); } catch (e) { log('shutdown err', e?.message); }
  log('done. messages =', count, '| event types =', [...types].join(', '));
}
