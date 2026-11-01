/**
 * Boot the web UI in headless Chrome and print every console message and
 * uncaught exception, so the swallowed plugin activation error becomes visible.
 *
 * Usage: node cdp-console.mjs <url-with-token> [ms-to-wait]
 */
const url = process.argv[2];
const waitMs = Number(process.argv[3] ?? 12000);
if (!url) throw new Error('need a url');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. wait for the CDP endpoint (chrome was launched by the caller)
let targets;
for (let i = 0; i < 40; i += 1) {
  try {
    const res = await fetch('http://127.0.0.1:9222/json/list');
    targets = await res.json();
    if (targets.length > 0) break;
  } catch {
    /* not up yet */
  }
  await sleep(250);
}
if (!targets?.length) throw new Error('no CDP target');

const page = targets.find((t) => t.type === 'page') ?? targets[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

const logs = [];

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id !== undefined) {
    const slot = pending.get(msg.id);
    if (slot) {
      pending.delete(msg.id);
      msg.error ? slot.reject(new Error(JSON.stringify(msg.error))) : slot.resolve(msg.result);
    }
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = msg.params.args
      .map((a) => {
        if (a.type === 'string') return a.value;
        if (a.type === 'undefined') return 'undefined';
        if (a.unserializableValue) return a.unserializableValue;
        if (a.preview?.properties) {
          return `{${a.preview.properties.map((p) => `${p.name}: ${p.value}`).join(', ')}}`;
        }
        return a.description ?? a.type;
      })
      .join(' ');
    logs.push(`[console.${msg.params.type}] ${text}`);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    const stack = d.stackTrace?.callFrames
      ?.slice(0, 6)
      .map((f) => `    at ${f.functionName || '<anon>'} (${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1})`)
      .join('\n');
    logs.push(`[exception] ${d.exception?.description ?? d.text}\n${stack ?? ''}`);
  }
  if (msg.method === 'Log.entryAdded') {
    const e = msg.params.entry;
    if (e.level === 'error' || e.level === 'warning') logs.push(`[log.${e.level}] ${e.text} ${e.url ?? ''}`);
  }
});

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Page.navigate', { url });

await sleep(waitMs);

// also read what the page actually rendered in the boot overlay
const body = await send('Runtime.evaluate', {
  expression: `(() => {
    const t = document.body.innerText || '';
    return t.slice(0, 1500);
  })()`,
  returnByValue: true,
});

console.log('===== CONSOLE / EXCEPTIONS =====');
console.log(logs.join('\n') || '(none)');
console.log('===== BODY TEXT =====');
console.log(body.result?.value ?? '(none)');
ws.close();
