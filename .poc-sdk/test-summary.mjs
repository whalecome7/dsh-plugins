// 验证滚动摘要用的单次调用参数是否可用
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
  const timer = setTimeout(() => log('  仍在等待…'), 20000);
  try {
    for await (const m of q) {
      if (m?.type === 'assistant') {
        for (const b of m.message?.content ?? []) if (b?.type === 'text') text += b.text;
      } else if (m?.type === 'result') {
        log('  result:', JSON.stringify({ subtype: m.subtype, is_error: m.is_error, credits: m.total_credits }).slice(0, 160));
        if (!text && typeof m.result === 'string') text = m.result;
      }
    }
  } catch (error) {
    log('  迭代错误:', error?.name, error?.message);
  } finally {
    clearTimeout(timer);
    try { await q?.close?.(); } catch {}
  }
  log('  文本:', JSON.stringify(text).slice(0, 200));
}

const base = { auth: qodercliAuth(), cwd: 'D:/code/dsh-plugins', maxTurns: 1 };

await attempt('A: 仅 model=Fast', { ...base, model: 'Fast' });
await attempt('B: model=Fast + systemPrompt preset append', {
  ...base,
  model: 'Fast',
  systemPrompt: { type: 'preset', preset: 'qodercli', append: systemPrompt },
});
await attempt('C: model=Fast + tools=[] + dontAsk', {
  ...base,
  model: 'Fast',
  tools: [],
  permissionMode: 'dontAsk',
});
await attempt('D: 全部组合', {
  ...base,
  model: 'Fast',
  tools: [],
  permissionMode: 'dontAsk',
  systemPrompt: { type: 'preset', preset: 'qodercli', append: systemPrompt },
});

try { await shutdownDaemon(); } catch {}
log('DONE');
