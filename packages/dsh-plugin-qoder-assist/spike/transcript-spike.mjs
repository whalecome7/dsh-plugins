#!/usr/bin/env node
// 只读 spike：观测 qodercli 会话 JSONL 的追加行为与 stop_reason 可靠性。
// 用法：
//   node transcript-spike.mjs                 # 监听最近活跃会话（从文件末尾开始）
//   node transcript-spike.mjs --from start    # 从文件开头回放
//   node transcript-spike.mjs --session <id|path>
//   node transcript-spike.mjs --list          # 列出所有会话
// 验证 --resume：让监听脚本跑着，在另一个终端执行脚本末尾打印的 resume 命令，
// 观察是否在原 session jsonl 上追加。脚本本身不写任何文件、不调用 SDK。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.join(os.homedir(), '.qoder', 'projects');
const POLL_MS = 500;

function parseArgs(argv) {
  const args = { from: 'end', session: null, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') args.from = argv[++i];
    else if (a === '--session') args.session = argv[++i];
    else if (a === '--list') args.list = true;
  }
  return args;
}

function projectDirName(dir) {
  return dir.replace(/^-/, '/').replace(/-/g, '/');
}

async function readCwd(projDir, id) {
  try {
    const raw = await fsp.readFile(path.join(projDir, id, 'state.json'), 'utf8');
    const st = JSON.parse(raw);
    if (st.workspaceDirectories?.[0]) return st.workspaceDirectories[0];
  } catch {}
  return projectDirName(path.basename(projDir));
}

function isAnalysisProject(dir) {
  return dir.endsWith('-.dsh-qoder-assist-workspace');
}

async function listSessions() {
  const out = [];
  for (const proj of await fsp.readdir(ROOT, { withFileTypes: true })) {
    if (!proj.isDirectory() || isAnalysisProject(proj.name)) continue;
    const projDir = path.join(ROOT, proj.name);
    for (const f of await fsp.readdir(projDir, { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const file = path.join(projDir, f.name);
      const st = await fsp.stat(file);
      out.push({
        file,
        id: f.name.replace(/\.jsonl$/, ''),
        project: proj.name,
        cwd: await readCwd(projDir, f.name.replace(/\.jsonl$/, '')),
        size: st.size,
        mtime: st.mtimeMs,
      });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function printList(sessions) {
  console.log(`发现 ${sessions.length} 个会话（最近活跃在前）：\n`);
  for (const s of sessions.slice(0, 20)) {
    const age = Math.round((Date.now() - s.mtime) / 60000);
    console.log(
      `${s.id}  ${String(Math.round(s.size / 1024)).padStart(6)}KB  ${String(age).padStart(4)}m前  ${s.cwd}`,
    );
  }
  const top = sessions[0];
  if (top) {
    console.log(`\n验证 resume：\n  cd ${top.cwd} && qodercli --resume ${top.id} -p "只回复 ok"`);
  }
}

async function findSession(idOrPath) {
  if (idOrPath && idOrPath.includes('/')) {
    const file = path.resolve(idOrPath);
    const st = await fsp.stat(file);
    const id = path.basename(file, '.jsonl');
    return { file, id, cwd: await readCwd(path.dirname(file), id), size: st.size, mtime: st.mtimeMs };
  }
  const sessions = await listSessions();
  if (idOrPath) {
    const hit = sessions.find((s) => s.id === idOrPath || s.id.startsWith(idOrPath));
    if (!hit) throw new Error(`找不到会话: ${idOrPath}`);
    return hit;
  }
  if (!sessions.length) throw new Error(`没有会话: ${ROOT}`);
  return sessions[0];
}

function truncate(s, n = 100) {
  const oneLine = String(s).replace(/\s+/g, ' ').trim();
  return oneLine.length > n ? oneLine.slice(0, n) + '…' : oneLine;
}

const TURN_END = new Set(['end_turn', 'stop_sequence', 'max_tokens']);

function describe(rec) {
  const msg = rec.message || {};
  const content = msg.content;
  const parts = [];
  let text = '';
  const tools = [];
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    for (const b of content) {
      if (b?.type === 'text') text += b.text || '';
      else if (b?.type === 'tool_use') tools.push(b.name || '?');
      else if (b?.type === 'tool_result') {
        const c = Array.isArray(b.content) ? b.content.map((x) => x.text || '').join('') : b.content || '';
        text += `[tool_result ${String(c).length}B]`;
      }
    }
  }
  if (text) parts.push(`text="${truncate(text)}"`);
  if (tools.length) parts.push(`tools=[${tools.join(',')}]`);
  if (rec.type === 'assistant' && msg.stop_reason) parts.push(`stop=${msg.stop_reason}`);
  return parts.join(' ') || '(empty)';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    printList(await listSessions());
    return;
  }

  const session = await findSession(args.session);
  console.log(`监听: ${session.file}`);
  console.log(`大小: ${session.size}B  模式: from=${args.from}  (Ctrl+C 结束)`);
  console.log(`会话 id: ${session.id}`);
  if (session.cwd && fs.existsSync(session.cwd)) {
    console.log(`验证 resume（另开终端执行）:\n  cd ${session.cwd} && qodercli --resume ${session.id} -p "只回复 ok"`);
  }
  console.log('');

  const st0 = await fsp.stat(session.file);
  let inode = st0.ino;
  let offset = args.from === 'start' ? 0 : st0.size;
  let lineStart = offset;
  let pending = Buffer.alloc(0);
  const counts = new Map();
  let parseErrors = 0;
  let bytesRead = 0;
  let turnEnds = 0;
  let lastChangeAt = Date.now();

  const report = () => {
    console.log('\n==== 汇总 ====');
    console.log(`读取字节: ${bytesRead}  解析错误: ${parseErrors}  回合结束: ${turnEnds}`);
    console.log('记录类型:', Object.fromEntries([...counts].sort()));
    console.log(`\n验证 resume：\n  cd ${session.cwd || '.'} && qodercli --resume ${session.id} -p "只回复 ok"`);
  };
  process.on('SIGINT', () => { report(); process.exit(0); });

  let timer;
  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      await readOnce();
    } finally {
      polling = false;
    }
  };

  const readOnce = async () => {
    let st;
    try {
      st = await fsp.stat(session.file);
    } catch (e) {
      await fsp.mkdir(path.dirname(session.file), { recursive: true }).catch(() => {});
      return;
    }
    if (st.ino !== inode) {
      console.log(`\n[文件被替换 inode ${inode} -> ${st.ino}，重置偏移]`);
      inode = st.ino;
      offset = 0;
      lineStart = 0;
      pending = Buffer.alloc(0);
    }
    if (st.size < offset) {
      console.log(`\n[文件截断 ${offset} -> ${st.size}，重置偏移]`);
      offset = 0;
      lineStart = 0;
      pending = Buffer.alloc(0);
    }
    if (st.size === offset) return;

    const size = st.size;
    const fh = await fsp.open(session.file, 'r');
    const chunk = Buffer.alloc(size - offset);
    const { bytesRead: n } = await fh.read(chunk, 0, chunk.length, offset);
    await fh.close();
    if (!n) return;

    const readAt = Date.now();
    const deltaMs = readAt - lastChangeAt;
    lastChangeAt = readAt;
    bytesRead += n;
    console.log(`\n[+${n}B  ${deltaMs}ms] offset ${offset} -> ${offset + n}`);

    offset += n;
    let buf = Buffer.concat([pending, chunk.subarray(0, n)]);
    let nl;
    while ((nl = buf.indexOf(0x0a)) !== -1) {
      const line = buf.subarray(0, nl);
      buf = buf.subarray(nl + 1);
      const start = lineStart;
      lineStart += line.length + 1;
      if (!line.length) continue;
      let rec;
      try {
        rec = JSON.parse(line.toString('utf8'));
      } catch {
        parseErrors++;
        console.log(`  @${start} PARSE_ERROR ${truncate(line.toString('utf8'), 80)}`);
        continue;
      }
      counts.set(rec.type || '?', (counts.get(rec.type || '?') || 0) + 1);
      const tag = `${rec.type}/${rec.message?.role || '-'}`;
      console.log(`  @${start} ${tag.padEnd(18)} ${describe(rec)}`);
      if (rec.type === 'assistant' && rec.message?.stop_reason) {
        const sr = rec.message.stop_reason;
        if (TURN_END.has(sr)) {
          turnEnds++;
          console.log(`  ---- 回合结束: stop_reason=${sr} ----`);
        } else {
          console.log(`  ---- 继续: stop_reason=${sr} ----`);
        }
      }
    }
    pending = Buffer.from(buf);
    if (pending.length) console.log(`  (pending ${pending.length}B，等待换行)`);
  };
  await poll();
  timer = setInterval(poll, POLL_MS);
  let watcher;
  try {
    watcher = fs.watch(session.file, () => { poll().catch(() => {}); });
    watcher.on('error', () => {});
  } catch {}
  process.on('exit', () => { clearInterval(timer); watcher?.close(); });
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
