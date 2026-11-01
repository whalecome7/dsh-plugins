// 找一组可用的摘要调用参数，并对比 credits 成本
import { qodercliAuth, query, shutdownDaemon } from '@qoder-ai/qoder-agent-sdk';

const t0 = Date.now();
const log = (...a) => console.log(`[${String(Date.now() - t0).padStart(6)}ms]`, ...a);

const prompt = [
  '已有摘要：（这是第一轮，还没有摘要）',
  '本轮新增对话：\n用户：只回答两个字：你好\n\n模型回复：你好',
  '请输出更新后的摘要。',
].join('\n\n');

const systemPrompt = '你是一个开发会话的记录员。输出中文 markdown 摘要，控制在 200 字以内。';

async function attempt(label, options) {
  log(`--- ${label} ---`);
  let q;
  try {
    q = query({ prompt, options });
  } catch (error) {
    log('  构造失败:', error?.message);
    return;
  }
  let text = '';
  let credits = null;
  try {
    for await (const m of q) {
      if (m?.type === 'assistant') {
        for (const b of m.message?.content ?? []) if (b?.type === 'text') text += b.text;
      } else if (m?.type === 'result') {
        credits = m.total_credits ?? null;
        if (!text && typeof m.result === 'string') text = m.result;
      }
    }
  } catch (error) {
    log('  迭代错误:', error?.name, error?.message);
  } finally {
    try { await q?.close?.(); } catch {}
  }
  log('  credits =', credits, '| 文本长度 =', text.length);
  log('  文本:', JSON.stringify(text).slice(0, 120));
  return credits;
}

const base = { auth: qodercliAuth(), cwd: 'D:/code/dsh-plugins', maxTurns: 1, permissionMode: 'default' };

const results = {};
results['E: Fast + tools=[] + sys'] = await attempt('E: Fast + tools=[] + default + sys', {
  ...base,
  model: 'Fast',
  tools: [],
  systemPrompt: { type: 'preset', preset: 'qodercli', append: systemPrompt },
});
results['F: Fast + sys (无 tools 限制)'] = await attempt('F: Fast + default + sys', {
  ...base,
  model: 'Fast',
  systemPrompt: { type: 'preset', preset: 'qodercli', append: systemPrompt },
});
results['G: Efficient + tools=[] + sys'] = await attempt('G: Efficient + tools=[] + default + sys', {
  ...base,
  model: 'Efficient',
  tools: [],
  systemPrompt: { type: 'preset', preset: 'qodercli', append: systemPrompt },
});

log('=== 成本对比 ===');
for (const [k, v] of Object.entries(results)) log(`  ${k} -> ${v}`);

try { await shutdownDaemon(); } catch {}
log('DONE');
