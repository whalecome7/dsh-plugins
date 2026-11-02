/**
 * Client half of Qoder Assist.
 *
 * Bundle format is dsh's module-loader wrapper: `require` resolves against the
 * shell's frozen module table, which already contains React.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-qoder-assist',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const { jsx, jsxs } = require('react/jsx-runtime');

    const PANEL_ID = 'qoder-assist';
    const API = '/api/qoder-assist';

    const C = {
      surface: 'rgba(127,127,127,0.10)',
      surfaceStrong: 'rgba(127,127,127,0.16)',
      border: 'rgba(127,127,127,0.28)',
      muted: 'rgba(127,127,127,0.85)',
      add: '#1a7f37',
      del: '#c93c37',
      warn: '#b7791f',
      danger: '#c93c37',
      accent: '#4b7bec',
    };

    const S = {
      root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, fontSize: '13px' },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '10px 16px',
        borderBottom: `1px solid ${C.border}`,
        flex: '0 0 auto',
      },
      title: { fontWeight: 600, fontSize: '13px', flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      columns: { flex: '1 1 auto', minHeight: 0, display: 'flex' },
      list: {
        width: '290px',
        flex: '0 0 290px',
        minHeight: 0,
        overflowY: 'auto',
        borderRight: `1px solid ${C.border}`,
        padding: '6px',
        boxSizing: 'border-box',
      },
      sessionItem: (active) => ({
        display: 'block',
        width: '100%',
        boxSizing: 'border-box',
        textAlign: 'left',
        border: 'none',
        borderRadius: '6px',
        background: active ? C.surfaceStrong : 'transparent',
        color: 'inherit',
        padding: '7px 8px',
        cursor: 'pointer',
        marginBottom: '2px',
        fontFamily: 'inherit',
      }),
      sessionTitle: { fontSize: '12px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      sessionMeta: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px', color: C.muted, marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      detail: { flex: '1 1 auto', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' },
      button: {
        border: `1px solid ${C.border}`,
        background: 'transparent',
        color: 'inherit',
        borderRadius: '5px',
        padding: '2px 7px',
        fontSize: '11px',
        cursor: 'pointer',
        lineHeight: 1.6,
        fontFamily: 'inherit',
      },
      tabs: { display: 'flex', gap: '2px', padding: '8px 16px 0', flex: '0 0 auto' },
      tab: (active) => ({
        border: 'none',
        borderBottom: active ? `2px solid ${C.accent}` : '2px solid transparent',
        background: 'transparent',
        color: 'inherit',
        opacity: active ? 1 : 0.62,
        padding: '3px 8px 5px',
        fontSize: '11px',
        cursor: 'pointer',
        fontFamily: 'inherit',
      }),
      status: (level) => ({
        flex: '0 0 auto',
        padding: '4px 16px',
        fontSize: '11px',
        background: level === 'warn' ? 'rgba(183,121,31,0.14)' : 'rgba(127,127,127,0.08)',
        color: level === 'warn' ? C.warn : C.muted,
        borderBottom: `1px solid ${C.border}`,
      }),
      body: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '12px 16px' },
      empty: { color: C.muted, fontSize: '12px', lineHeight: 1.7, padding: '12px 4px' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px' },
      select: {
        border: `1px solid ${C.border}`,
        background: 'transparent',
        color: 'inherit',
        borderRadius: '5px',
        padding: '2px 4px',
        fontSize: '11px',
        maxWidth: '100%',
        fontFamily: 'inherit',
      },
      footer: { flex: '0 0 auto', borderTop: `1px solid ${C.border}`, padding: '6px 16px' },
    };

    function getJson(url) {
      return fetch(url, { headers: { accept: 'application/json' } }).then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
        return payload;
      });
    }

    function postJson(url, body) {
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      }).then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
        return payload;
      });
    }

    function timeAgo(ts) {
      if (!ts) return '';
      const diff = Date.now() - ts;
      if (diff < 60 * 1000) return '刚刚';
      if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
      if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
      return `${Math.floor(diff / 86400000)} 天前`;
    }

    function shortId(id) {
      return String(id || '').slice(0, 8);
    }

    function toolInput(raw) {
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    }

    function toolSummary(tool) {
      try {
        const input = typeof tool.input === 'string' ? JSON.parse(tool.input) : tool.input;
        if (input && typeof input === 'object') {
          const command = input.command ?? input.cmd;
          if (command) return `${tool.name}: ${String(command).slice(0, 120)}`;
          const file = input.file_path ?? input.filePath ?? input.path ?? input.notebook_path;
          if (file) return `${tool.name}: ${file}`;
          if (input.pattern) return `${tool.name}: ${input.pattern}`;
          if (input.url) return `${tool.name}: ${input.url}`;
        }
      } catch {}
      return tool.name;
    }

    // ---------------------------------------------------------------- pieces

    function ToolCard({ tool, result }) {
      const [open, setOpen] = react.useState(false);
      const bad = result && result.isError;
      return jsxs('div', {
        style: {
          marginBottom: '6px',
          border: `1px solid ${bad ? C.danger : C.border}`,
          borderRadius: '6px',
          overflow: 'hidden',
        },
        children: [
          jsxs('button', {
            onClick: () => setOpen(!open),
            style: {
              width: '100%',
              textAlign: 'left',
              border: 'none',
              background: C.surface,
              color: 'inherit',
              padding: '5px 8px',
              cursor: 'pointer',
              display: 'flex',
              gap: '6px',
              alignItems: 'center',
              fontSize: '11px',
              fontFamily: 'inherit',
            },
            children: [
              jsx('span', { style: { opacity: 0.55, flex: '0 0 auto' }, children: open ? '▾' : '▸' }),
              jsx('span', { style: { ...S.mono, flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: toolSummary(tool) }),
              result
                ? jsx('span', { style: { flex: '0 0 auto', color: bad ? C.danger : C.muted }, children: bad ? '失败' : '完成' })
                : jsx('span', { style: { flex: '0 0 auto', color: C.muted }, children: '…' }),
            ],
          }),
          open
            ? jsxs('div', { style: { padding: '6px 8px', borderTop: `1px solid ${C.border}` }, children: [
                jsx('div', { style: { ...S.mono, color: C.muted, marginBottom: '4px' }, children: '输入' }),
                jsx('pre', {
                  style: { ...S.mono, margin: '0 0 8px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '160px', overflow: 'auto' },
                  children: typeof tool.input === 'string' ? tool.input : JSON.stringify(tool.input, null, 2),
                }),
                result
                  ? jsxs('div', { children: [
                      jsx('div', { style: { ...S.mono, color: C.muted, marginBottom: '4px' }, children: '输出' }),
                      jsx('pre', {
                        style: { ...S.mono, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '220px', overflow: 'auto' },
                        children: result.text,
                      }),
                    ] })
                  : null,
              ] })
            : null,
        ],
      });
    }

    function MessageRow({ message, results }) {
      if (message.meta) return null;
      if (message.role === 'user') {
        // Tool results are rendered inside their tool cards, not as user bubbles.
        if (!message.text && message.toolResults?.length) return null;
        return jsxs('div', {
          style: {
            alignSelf: 'flex-end',
            maxWidth: '92%',
            marginLeft: 'auto',
            marginBottom: '8px',
            padding: '6px 9px',
            borderRadius: '8px',
            background: C.surfaceStrong,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontSize: '12px',
          },
          children: [message.text || '（工具结果）'],
        });
      }

      return jsxs('div', { style: { marginBottom: '6px' }, children: [
        message.text
          ? jsx('div', { style: { marginBottom: '6px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.6 }, children: message.text })
          : null,
        message.thinking
          ? jsx('details', {
              style: { ...S.mono, color: C.muted, marginBottom: '6px' },
              children: [
                jsx('summary', { style: { cursor: 'pointer' }, children: '思考' }),
                jsx('div', { style: { whiteSpace: 'pre-wrap', marginTop: '4px' }, children: message.thinking }),
              ],
            })
          : null,
        message.tools.map((tool) => jsx(ToolCard, { tool, result: results.get(tool.id) }, tool.id || `${message.offset}-${tool.name}`)),
        message.toolResults.map((result) =>
          jsx('div', { style: { ...S.mono, color: result.isError ? C.danger : C.muted, marginBottom: '6px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }, children: result.text }, `${message.offset}-${result.toolUseId}`),
        ),
        message.stopReason
          ? jsx('div', { style: { ...S.mono, color: C.muted, opacity: 0.6, margin: '2px 0 8px', textAlign: 'center' }, children: `— ${message.stopReason} —` })
          : null,
      ] });
    }

    function SuggestionCard({ suggestion, onFeedback }) {
      const [open, setOpen] = react.useState(true);
      const [items, setItems] = react.useState(suggestion.items ?? []);
      react.useEffect(() => setItems(suggestion.items ?? []), [suggestion.id]);

      const vote = (index, value) => {
        setItems((current) => current.map((item, i) => (i === index ? { ...item, feedback: value } : item)));
        onFeedback(suggestion.id, index, value);
      };

      return jsxs('div', {
        style: {
          margin: '4px 0 10px',
          border: `1px solid ${C.accent}`,
          borderRadius: '6px',
          background: 'rgba(75,123,236,0.06)',
          overflow: 'hidden',
        },
        children: [
          jsxs('button', {
            onClick: () => setOpen(!open),
            style: {
              width: '100%',
              textAlign: 'left',
              border: 'none',
              background: 'transparent',
              color: 'inherit',
              padding: '5px 8px',
              cursor: 'pointer',
              display: 'flex',
              gap: '6px',
              alignItems: 'center',
              fontSize: '11px',
              fontFamily: 'inherit',
            },
            children: [
              jsx('span', { style: { opacity: 0.6 }, children: open ? '▾' : '▸' }),
              jsx('span', { style: { flex: '1 1 auto', fontWeight: 600 }, children: `建议 · ${items.length} 项` }),
              jsx('span', { style: { color: C.muted }, children: suggestion.trigger === 'manual' ? '手动' : '自动' }),
            ],
          }),
          open
            ? jsx('div', { style: { padding: '0 8px 8px' }, children: items.map((item, index) =>
                jsxs('div', { style: { padding: '6px 0', borderTop: index ? `1px solid ${C.border}` : 'none' }, children: [
                  jsx('div', { style: { fontWeight: 600, marginBottom: '3px', lineHeight: 1.5 }, children: item.title }),
                  item.detail ? jsx('div', { style: { fontSize: '11px', lineHeight: 1.6, whiteSpace: 'pre-wrap' }, children: item.detail }) : null,
                  jsxs('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', marginTop: '4px' }, children: [
                    item.evidence ? jsx('span', { style: { ...S.mono, color: C.muted, flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: item.evidence }) : jsx('span', { style: { flex: '1 1 auto' } }),
                    jsx('button', { style: { ...S.button, opacity: item.feedback === 'up' ? 1 : 0.55 }, onClick: () => vote(index, 'up'), children: '有用' }),
                    jsx('button', { style: { ...S.button, opacity: item.feedback === 'down' ? 1 : 0.55 }, onClick: () => vote(index, 'down'), children: '无用' }),
                  ] }),
                ] }, index),
              ) })
            : null,
        ],
      });
    }

    function SummaryView({ sessionId, summary, loading, onGenerate, onRefresh }) {
      return jsxs('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }, children: [
        jsxs('div', { style: { display: 'flex', gap: '6px', marginBottom: '8px' }, children: [
          jsx('button', { style: S.button, onClick: onGenerate, disabled: loading, children: loading ? '生成中…' : '生成摘要' }),
          jsx('button', { style: S.button, onClick: onRefresh, children: '刷新' }),
        ] }),
        summary
          ? jsx('div', { style: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', whiteSpace: 'pre-wrap', lineHeight: 1.7, fontSize: '12px' }, children: summary })
          : jsx('div', { style: S.empty, children: '还没有摘要。点「生成摘要」会用你的 Qoder 账号分析这个会话，结果保存在本地。' }),
      ] });
    }

    function SettingsView({ state, hooks, onHooks, busy, flash }) {
      const analyzer = state?.analyzer ?? {};
      const events = hooks?.events ?? {};
      return jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '12px', lineHeight: 1.7 }, children: [
        jsxs('div', { children: [
          jsx('div', { style: { fontWeight: 600, marginBottom: '4px' }, children: 'qodercli hooks' }),
          jsx('div', { style: { color: C.muted, fontSize: '11px', marginBottom: '6px' }, children: 'hooks 只补充 transcript 里没有的事件（权限确认、会话起止）。不装也能正常镜像和复盘。' }),
          jsx('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '6px' }, children: Object.keys(events).map((name) =>
            jsx('span', {
              style: {
                ...S.mono,
                padding: '1px 5px',
                borderRadius: '4px',
                border: `1px solid ${C.border}`,
                color: events[name] ? C.add : C.muted,
              },
              children: `${events[name] ? '✓' : '·'} ${name}`,
            }, name),
          ) }),
          jsxs('div', { style: { display: 'flex', gap: '6px' }, children: [
            jsx('button', { style: S.button, disabled: busy, onClick: () => onHooks('install'), children: '安装 hooks' }),
            jsx('button', { style: S.button, disabled: busy, onClick: () => onHooks('uninstall'), children: '卸载 hooks' }),
          ] }),
        ] }),
        jsxs('div', { children: [
          jsx('div', { style: { fontWeight: 600, marginBottom: '4px' }, children: '分析' }),
          jsx('div', { style: { color: C.muted, fontSize: '11px' }, children: `并发上限 1，队列 ${analyzer.queued ?? 0}，每会话 ${analyzer.caps?.hourly ?? 6} 次/小时，全局 ${analyzer.caps?.daily ?? 200} 次/天。` }),
          jsx('div', { style: { color: C.muted, fontSize: '11px' }, children: `今日已用 ${state?.quota?.daily?.used ?? 0} 次。分析会话零工具，内容发送前做密码类脱敏。` }),
          analyzer.disabled
            ? jsx('div', { style: { color: C.warn, fontSize: '11px', marginTop: '4px' }, children: '分析已禁用（DSH_QODER_ASSIST_NO_ANALYZE=1），镜像与历史仍可用。' })
            : null,
          analyzer.paused?.length
            ? jsx('div', { style: { color: C.warn, fontSize: '11px', marginTop: '4px' }, children: `暂停中：${analyzer.paused.map((item) => `${shortId(item.sessionId)} ${item.reason}`).join('；')}` })
            : null,
        ] }),
        jsxs('div', { children: [
          jsx('div', { style: { fontWeight: 600, marginBottom: '4px' }, children: '位置' }),
          jsx('div', { style: { ...S.mono, color: C.muted, wordBreak: 'break-all' }, children: state?.assistRoot || '' }),
          hooks?.settingsFile ? jsx('div', { style: { ...S.mono, color: C.muted, wordBreak: 'break-all' }, children: `hooks 配置：${hooks.settingsFile}` }) : null,
        ] }),
        jsx('div', { style: { color: C.muted, fontSize: '11px' }, children: '已知限制：--no-session-persistence 与云会话不可见；子代理对话不展开。' }),
        flash ? jsx('div', { style: { color: C.warn, fontSize: '11px' }, children: flash }) : null,
      ] });
    }

    // ------------------------------------------------------- shared store

    function createShared() {
      const subscribers = new Set();
      const shared = {
        state: null,
        sessionId: null,
        messages: [],
        suggestions: [],
        summary: '',
        hooks: null,
        error: null,
        flash: null,
        earliest: 0,
        seq: 0,
        busy: false,
        summaryLoading: false,
        started: false,
        timer: null,
        source: null,
        flashTimer: null,

        subscribe(fn) {
          subscribers.add(fn);
          return () => subscribers.delete(fn);
        },
        notify() {
          for (const fn of subscribers) {
            try {
              fn();
            } catch {}
          }
        },
        set(patch) {
          Object.assign(shared, patch);
          shared.notify();
        },
        flashNow(text) {
          shared.set({ flash: text });
          clearTimeout(shared.flashTimer);
          shared.flashTimer = setTimeout(() => shared.set({ flash: null }), 6000);
        },

        async loadState() {
          try {
            const next = await getJson(`${API}.state`);
            const previous = shared.sessionId;
            shared.set({ state: next });
            if (!previous) {
              const id = next.defaultSessionId ?? next.sessions?.[0]?.id ?? null;
              if (id) void shared.selectSession(id);
            }
          } catch (err) {
            shared.set({ error: err.message });
          }
        },

        async selectSession(id) {
          if (!id) return;
          shared.set({ sessionId: id, messages: [], suggestions: [], summary: '', earliest: 0, error: null });
          try {
            const [page, sug, sum] = await Promise.all([
              getJson(`${API}.messages?sessionId=${encodeURIComponent(id)}&limit=200`),
              getJson(`${API}.suggestions?sessionId=${encodeURIComponent(id)}`),
              getJson(`${API}.summary?sessionId=${encodeURIComponent(id)}`),
            ]);
            if (shared.sessionId !== id) return;
            shared.set({
              messages: page.messages ?? [],
              earliest: page.earliest ?? 0,
              suggestions: sug.suggestions ?? [],
              summary: sum.markdown ?? '',
            });
            const lastOffset = (page.messages ?? []).reduce((max, message) => Math.max(max, message.offset || 0), 0);
            if (lastOffset) void postJson(`${API}.read`, { sessionId: id, offset: lastOffset }).catch(() => {});
          } catch (err) {
            shared.set({ error: err.message });
          }
        },

        async loadEarlier() {
          const id = shared.sessionId;
          const before = shared.earliest;
          if (!id || !before) return;
          try {
            const page = await getJson(`${API}.messages?sessionId=${encodeURIComponent(id)}&before=${before}&limit=200`);
            if (shared.sessionId !== id) return;
            const list = page.messages ?? [];
            if (!list.length) {
              shared.set({ earliest: 0 });
              return;
            }
            const known = new Set(shared.messages.map((message) => message.offset));
            shared.set({
              messages: list.filter((message) => !known.has(message.offset)).concat(shared.messages),
              earliest: page.earliest ?? list[0].offset,
            });
          } catch (err) {
            shared.set({ error: err.message });
          }
        },

        async refreshSummary() {
          const id = shared.sessionId;
          if (!id) return;
          try {
            const sum = await getJson(`${API}.summary?sessionId=${encodeURIComponent(id)}`);
            if (shared.sessionId === id) shared.set({ summary: sum.markdown ?? '' });
          } catch (err) {
            shared.set({ error: err.message });
          }
        },

        async generateSummary() {
          const id = shared.sessionId;
          if (!id) return;
          shared.set({ summaryLoading: true, error: null });
          try {
            const result = await postJson(`${API}.summary`, { sessionId: id });
            if (result.ok === false) throw new Error(result.error || '生成失败');
            shared.flashNow('已提交摘要生成，完成后会自动刷新');
          } catch (err) {
            shared.set({ error: err.message });
          } finally {
            shared.set({ summaryLoading: false });
          }
        },

        async analyze() {
          const id = shared.sessionId;
          if (!id) return;
          shared.set({ busy: true, error: null });
          try {
            const result = await postJson(`${API}.analyze`, { sessionId: id });
            if (result.ok === false) throw new Error(result.error || '分析失败');
            shared.flashNow(result.reason ? `未提交：${result.reason}` : '已提交分析');
          } catch (err) {
            shared.set({ error: err.message });
          } finally {
            shared.set({ busy: false });
          }
        },

        async hooksAction(action) {
          shared.set({ busy: true, error: null });
          try {
            const next = await postJson(`${API}.hooks`, { action });
            shared.set({ hooks: next });
            shared.flashNow(action === 'install' ? 'hooks 已安装' : 'hooks 已卸载');
          } catch (err) {
            shared.set({ error: err.message });
          } finally {
            shared.set({ busy: false });
          }
        },

        feedback(sessionId, suggestionId, itemIndex, value) {
          void postJson(`${API}.feedback`, { sessionId, suggestionId, itemIndex, value }).catch(() => {});
        },

        start() {
          if (shared.started) return;
          shared.started = true;
          void shared.loadState();
          getJson(`${API}.hooks`).then((next) => shared.set({ hooks: next })).catch(() => {});
          shared.timer = setInterval(() => { void shared.loadState(); }, 5000);
          shared.source = new EventSource(`${API}.stream?from=0`);
          shared.source.onmessage = (event) => {
            let data;
            try {
              data = JSON.parse(event.data);
            } catch {
              return;
            }
            if (!data || typeof data.seq !== 'number' || data.seq <= shared.seq) return;
            shared.seq = data.seq;

            if (data.type === 'messages' && data.sessionId === shared.sessionId) {
              const known = new Set(shared.messages.map((message) => message.offset));
              const fresh = (data.messages ?? []).filter((message) => !known.has(message.offset));
              if (fresh.length) {
                shared.set({
                  messages: shared.messages.concat(fresh),
                  earliest: shared.earliest || fresh[0].offset,
                });
              }
            } else if (data.type === 'suggestion' && data.sessionId === shared.sessionId) {
              if (!shared.suggestions.some((item) => item.id === data.suggestion.id)) {
                shared.set({ suggestions: shared.suggestions.concat(data.suggestion) });
              }
              shared.flashNow('收到 1 条新建议');
            } else if (data.type === 'summary' && data.sessionId === shared.sessionId) {
              void shared.refreshSummary();
            } else if (data.type === 'permission') {
              shared.flashNow(`终端需要确认：${data.toolName || '工具调用'}`);
            } else if (data.type === 'status') {
              if (shared.state) {
                shared.set({ state: { ...shared.state, analyzer: { ...shared.state.analyzer, lastStatus: data.message } } });
              }
            } else if (data.type === 'session' || data.type === 'reset') {
              void shared.loadState();
            }
          };
          shared.source.onerror = () => {};
        },

        stop() {
          if (shared.timer) clearInterval(shared.timer);
          shared.timer = null;
          if (shared.source) shared.source.close();
          shared.source = null;
          clearTimeout(shared.flashTimer);
          shared.started = false;
        },
      };
      return shared;
    }

    const shared = createShared();

    function AssistIcon({ size = 16 }) {
      return jsx('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: '1.4',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        children: [
          jsx('path', { d: 'M2.5 3.5h11v7.5h-6l-3 2.5v-2.5h-2z' }, 'bubble'),
          jsx('path', { d: 'M5 6.5h6M5 8.8h4' }, 'lines'),
        ],
      });
    }

    function App() {
      const [, force] = react.useState(0);
      const [view, setView] = react.useState('chat');

      react.useEffect(() => {
        shared.start();
        return shared.subscribe(() => force((value) => value + 1));
      }, []);

      const state = shared.state;
      const sessionId = shared.sessionId;
      const suggestions = shared.suggestions;
      const messages = shared.messages;
      const sessions = state?.sessions ?? [];
      const current = sessions.find((session) => session.id === sessionId) ?? null;
      const analyzerStatus = state?.analyzer?.lastStatus
        || (state?.analyzer?.paused?.length ? `分析暂停：${state.analyzer.paused[0].reason}` : null);

      const results = react.useMemo(() => {
        const map = new Map();
        for (const message of messages) for (const result of message.toolResults ?? []) map.set(result.toolUseId, result);
        return map;
      }, [messages]);

      const rows = react.useMemo(() => {
        const out = [];
        let index = 0;
        const sorted = [...suggestions].sort((a, b) => (a.anchorOffset ?? 0) - (b.anchorOffset ?? 0));
        for (const message of messages) {
          while (index < sorted.length && (sorted[index].anchorOffset ?? 0) < message.offset) {
            out.push({ type: 'suggestion', key: `sg-${sorted[index].id}`, suggestion: sorted[index] });
            index += 1;
          }
          if (!message.meta) out.push({ type: 'message', key: `m-${message.offset}`, message });
        }
        while (index < sorted.length) {
          out.push({ type: 'suggestion', key: `sg-${sorted[index].id}`, suggestion: sorted[index] });
          index += 1;
        }
        return out;
      }, [messages, suggestions]);

      const sessionList = sessions.slice(0, 200).map((session) =>
        jsxs('button', {
          type: 'button',
          onClick: () => shared.selectSession(session.id),
          style: S.sessionItem(session.id === sessionId),
          children: [
            jsx('div', { style: S.sessionTitle, children: `${session.active ? '● ' : ''}${session.title || shortId(session.id)}` }),
            jsx('div', { style: S.sessionMeta, children: `${session.projectLabel} · ${timeAgo(session.mtime)}` }),
          ],
        }, session.id),
      );

      return jsxs('div', { style: S.root, children: [
        jsxs('div', { style: S.header, children: [
          jsx('div', { style: S.title, children: 'Qoder 助手' }),
          current?.active ? jsx('span', { style: { color: C.add, fontSize: '11px' }, children: '● 活跃' }) : null,
          jsx('span', { style: { ...S.mono, color: C.muted }, children: sessions.length ? `${sessions.length} 个会话` : '' }),
          jsx('button', { style: S.button, onClick: () => shared.loadState(), children: '刷新' }),
          jsx('button', {
            style: { ...S.button, background: C.accent, color: '#fff', borderColor: C.accent, opacity: shared.busy || !sessionId ? 0.5 : 1 },
            disabled: shared.busy || !sessionId,
            onClick: () => shared.analyze(),
            children: shared.busy ? '分析中' : '分析一下',
          }),
        ] }),
        jsx('div', { style: S.status(analyzerStatus ? 'warn' : 'normal'), children: analyzerStatus || (current ? `监听中 · ${current.projectLabel}` : '等待 qodercli 会话') }),

        jsxs('div', { style: S.columns, children: [
          jsx('div', { style: S.list, children: sessionList.length
            ? sessionList
            : jsx('div', { style: S.empty, children: '还没有发现 qodercli 会话。在终端里跑一次 qodercli 即可出现在这里。' }) }),

          jsxs('div', { style: S.detail, children: [
            jsxs('div', { style: S.tabs, children: [
              jsx('button', { style: S.tab(view === 'chat'), onClick: () => setView('chat'), children: '对话' }),
              jsx('button', { style: S.tab(view === 'summary'), onClick: () => setView('summary'), children: '摘要' }),
              jsx('button', { style: S.tab(view === 'settings'), onClick: () => setView('settings'), children: '设置' }),
            ] }),

            view === 'chat'
              ? jsx('div', { style: S.body, children: !sessionId
                  ? jsx('div', { style: S.empty, children: '从左侧选择一个会话。' })
                  : jsxs('div', { children: [
                      shared.earliest ? jsx('div', { style: { textAlign: 'center', marginBottom: '8px' }, children: jsx('button', { style: S.button, onClick: () => shared.loadEarlier(), children: '加载更早' }) }) : null,
                      rows.map((row) => row.type === 'suggestion'
                        ? jsx(SuggestionCard, { suggestion: row.suggestion, onFeedback: shared.feedback }, row.key)
                        : jsx(MessageRow, { message: row.message, results }, row.key)),
                      !rows.length ? jsx('div', { style: S.empty, children: '这个会话还没有可展示的消息。' }) : null,
                    ] }) })
              : view === 'summary'
                ? jsx('div', { style: S.body, children: jsx(SummaryView, {
                    sessionId,
                    summary: shared.summary,
                    loading: shared.summaryLoading,
                    onGenerate: () => shared.generateSummary(),
                    onRefresh: () => shared.refreshSummary(),
                  }) })
                : jsx('div', { style: S.body, children: jsx(SettingsView, { state, hooks: shared.hooks, onHooks: (action) => shared.hooksAction(action), busy: shared.busy, flash: shared.flash }) }),
          ] }),
        ] }),

        shared.flash || shared.error
          ? jsxs('div', { style: S.footer, children: [
              shared.error ? jsx('div', { style: { color: C.danger, fontSize: '11px' }, children: shared.error }) : null,
              shared.flash ? jsx('div', { style: { color: C.muted, fontSize: '11px' }, children: shared.flash }) : null,
            ] })
          : null,
      ] });
    }

    function apply(ctx) {
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, App));
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 20,
        label: () => 'Qoder 助手',
      }, AssistIcon));
      ctx.effect(() => () => shared.stop(), 'qoder-assist: shared transport');
      console.log('[qoder-assist] main panel + sidebar entry registered');
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    return module.exports;

  },
});
