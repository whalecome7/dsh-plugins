// POC Step 4: 多轮会话上下文保持 + daemon 复用
import { qodercliAuth, query, shutdownDaemon } from '@qoder-ai/qoder-agent-sdk';

const t0 = Date.now();
const log = (...a) => console.log(`[${String(Date.now() - t0).padStart(6)}ms]`, ...a);

const CWD = 'D:/code/dsh-plugins/.poc-sdk';

function userMsg(text) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null };
}

// ---- 测试 A：同一 query 内多轮，验证上下文保持 ----
log('--- A: 多轮会话 ---');
async function* conv() {
  yield userMsg('请记住这个暗号：紫罗兰-7734。只回答"已记住"。');
  yield userMsg('我刚才让你记住的暗号是什么？只回答暗号本身。');
}

const tA = Date.now();
let sidA = null;
let textsA = [];
const qA = query({ prompt: conv(), options: { auth: qodercliAuth(), cwd: CWD, maxTurns: 4 } });
try {
  for await (const m of qA) {
    if (m.type === 'system' && m.subtype === 'init' && m.session_id) sidA = m.session_id;
    if (m.type === 'assistant') {
      for (const b of m.message?.content ?? []) {
        if (b.type === 'text') { textsA.push(b.text); log('   A text:', JSON.stringify(b.text).slice(0, 120)); }
      }
    }
    if (m.type === 'result') log('   A result:', JSON.stringify(m.result).slice(0, 200));
  }
} catch (e) { log('A ERROR:', e?.name, e?.message); }
finally { try { await qA.close?.(); } catch {} }
log(`A 耗时 = ${Date.now() - tA}ms | session_id = ${sidA}`);
const kept = /紫罗兰|7734/.test(textsA.join(' '));
log('A 上下文保持 =', kept);

// ---- 测试 B：第二个 query，验证 daemon 复用（应明显快于首次） ----
log('--- B: daemon 复用 ---');
const tB = Date.now();
const qB = query({ prompt: '只回答三个字：收到了', options: { auth: qodercliAuth(), cwd: CWD, maxTurns: 1 } });
try {
  for await (const m of qB) {
    if (m.type === 'result') log('   B result:', JSON.stringify(m.result).slice(0, 120));
  }
} catch (e) { log('B ERROR:', e?.name, e?.message); }
finally { try { await qB.close?.(); } catch {} }
log(`B 耗时 = ${Date.now() - tB}ms`);

// ---- 测试 C：用 session_id 续接到新 query ----
if (sidA) {
  log('--- C: 用 resume 续接会话 ---');
  const tC = Date.now();
  try {
    const qC = query({
      prompt: '继续刚才的对话：请再说一次那个暗号。',
      options: { auth: qodercliAuth(), cwd: CWD, maxTurns: 2, resume: sidA },
    });
    for await (const m of qC) {
      if (m.type === 'assistant') {
        for (const b of m.message?.content ?? []) {
          if (b.type === 'text') log('   C text:', JSON.stringify(b.text).slice(0, 150));
        }
      }
      if (m.type === 'result') log('   C result:', JSON.stringify(m.result).slice(0, 200));
    }
    await qC.close?.();
  } catch (e) { log('C ERROR:', e?.name, e?.message); }
  log(`C 耗时 = ${Date.now() - tC}ms`);
}

try { await shutdownDaemon?.(); } catch {}
log('=== DONE ===');
