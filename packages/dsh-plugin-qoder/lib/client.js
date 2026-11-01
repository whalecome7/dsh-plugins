/**
 * Client half of the Qoder panel.
 *
 * Bundle format is dsh's module-loader wrapper (not plain ESM): the factory
 * receives a `require` that resolves against the shell's frozen module table,
 * where `react` and `react/jsx-runtime` are already present.
 *
 * Everything else is plain browser API: the panel talks to its own host half
 * over `fetch('/api/qoder.*')`, and streams turns through EventSource.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-qoder',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const { jsx, jsxs } = require('react/jsx-runtime');

    const TAB_ID = 'dsh-plugin-qoder/panel';
    const TAB_KIND = 'qoder';

    const MODELS = [
      'Auto',
      'Ultimate',
      'Fast',
      'Efficient',
      'DeepSeek-V4-Pro',
      'DeepSeek-Flash',
      'GLM-5.3',
      'GLM-5.3-Flash',
      'Kimi-K3.1-Pro',
      'Kimi-K2.8-Preview',
      'Qwen3.8-Max',
      'Qwen3.8-Flash',
      'MiniMax-M3.1-Flash',
      'Sonus',
      'Cantus',
    ];

    // Theme-agnostic palette: neutral translucent surfaces inherit the shell's
    // text colour, so the panel stays legible in both light and dark themes.
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
        gap: '6px',
        padding: '8px 10px',
        borderBottom: `1px solid ${C.border}`,
        flex: '0 0 auto',
      },
      title: { fontWeight: 600, fontSize: '12px', flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      iconButton: {
        border: `1px solid ${C.border}`,
        background: 'transparent',
        color: 'inherit',
        borderRadius: '5px',
        padding: '2px 7px',
        fontSize: '11px',
        cursor: 'pointer',
        lineHeight: 1.6,
      },
      tabs: { display: 'flex', gap: '2px', padding: '6px 10px 0' },
      tab: (active) => ({
        border: 'none',
        borderBottom: active ? `2px solid ${C.accent}` : '2px solid transparent',
        background: 'transparent',
        color: 'inherit',
        opacity: active ? 1 : 0.62,
        padding: '3px 8px 5px',
        fontSize: '11px',
        cursor: 'pointer',
      }),
      body: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '10px' },
      footer: { flex: '0 0 auto', borderTop: `1px solid ${C.border}`, padding: '8px 10px' },
      textarea: {
        width: '100%',
        boxSizing: 'border-box',
        resize: 'none',
        border: `1px solid ${C.border}`,
        borderRadius: '6px',
        background: 'transparent',
        color: 'inherit',
        padding: '7px 8px',
        fontSize: '12px',
        fontFamily: 'inherit',
        lineHeight: 1.5,
        outline: 'none',
      },
      row: { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px' },
    };

    // ------------------------------------------------------------------ utils

    function postJson(path, body) {
      return fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      }).then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok && response.status !== 409) {
          throw new Error(payload?.error || `HTTP ${response.status}`);
        }
        return payload;
      });
    }

    function getJson(path) {
      return fetch(path, { headers: { accept: 'application/json' } }).then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      });
    }

    function formatCredits(value) {
      if (!value) return '0';
      return Number(value).toFixed(5).replace(/0+$/, '').replace(/\.$/, '');
    }

    /** Colour a unified patch line by its prefix. */
    function patchLineStyle(line) {
      if (line.startsWith('+++') || line.startsWith('---')) return { color: C.muted };
      if (line.startsWith('+')) return { color: C.add };
      if (line.startsWith('-')) return { color: C.del };
      if (line.startsWith('@@')) return { color: C.accent };
      return {};
    }

    // ------------------------------------------------------------ sub-views

    function Bubble({ text }) {
      return jsx('div', {
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
        children: text,
      });
    }

    function AssistantText({ text }) {
      return jsx('div', {
        style: { marginBottom: '8px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.6 },
        children: text,
      });
    }

    function ToolCard({ event, result }) {
      const [open, setOpen] = react.useState(false);
      const summary = describeTool(event.name, event.input);
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
              jsx('span', { style: { ...S.mono, flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: summary }),
              result ? jsx('span', { style: { flex: '0 0 auto', color: bad ? C.danger : C.muted }, children: bad ? '失败' : '✓' }) : jsx('span', { style: { flex: '0 0 auto', color: C.muted }, children: '…' }),
            ],
          }),
          open
            ? jsxs('div', { style: { padding: '6px 8px', borderTop: `1px solid ${C.border}` }, children: [
                jsx('div', { style: { ...S.mono, color: C.muted, marginBottom: '4px' }, children: '输入' }),
                jsx('pre', {
                  style: { ...S.mono, margin: '0 0 8px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '180px', overflow: 'auto' },
                  children: JSON.stringify(event.input, null, 2),
                }),
                result
                  ? jsxs('div', { children: [
                      jsx('div', { style: { ...S.mono, color: C.muted, marginBottom: '4px' }, children: '输出' }),
                      jsx('pre', {
                        style: { ...S.mono, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '240px', overflow: 'auto' },
                        children: result.text,
                      }),
                    ] })
                  : null,
              ] })
            : null,
        ],
      });
    }

    function ApprovalCard({ event, onDecide, busy }) {
      const [expanded, setExpanded] = react.useState(false);
      return jsxs('div', {
        style: {
          marginBottom: '8px',
          border: `1px solid ${C.warn}`,
          borderRadius: '6px',
          padding: '8px',
          background: C.surface,
        },
        children: [
          jsx('div', { style: { fontWeight: 600, fontSize: '12px', marginBottom: '4px' }, children: event.title || event.toolName }),
          event.description
            ? jsx('div', { style: { fontSize: '11px', color: C.muted, marginBottom: '6px', lineHeight: 1.5 }, children: event.description })
            : null,
          jsx('button', {
            onClick: () => setExpanded(!expanded),
            style: { ...S.iconButton, marginBottom: '6px' },
            children: expanded ? '收起参数' : '查看参数',
          }),
          expanded
            ? jsx('pre', {
                style: { ...S.mono, margin: '0 0 6px', padding: '6px', background: C.surfaceStrong, borderRadius: '4px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '200px', overflow: 'auto' },
                children: JSON.stringify(event.input, null, 2),
              })
            : null,
          jsxs('div', { style: { display: 'flex', gap: '6px' }, children: [
            jsx('button', {
              disabled: busy,
              onClick: () => onDecide(event.approvalId, 'allow'),
              style: { ...S.iconButton, background: C.accent, color: '#fff', borderColor: C.accent, opacity: busy ? 0.6 : 1 },
              children: '允许',
            }),
            jsx('button', {
              disabled: busy,
              onClick: () => onDecide(event.approvalId, 'deny'),
              style: { ...S.iconButton, opacity: busy ? 0.6 : 1 },
              children: '拒绝',
            }),
          ] }),
        ],
      });
    }

    function describeTool(name, input) {
      if (!input || typeof input !== 'object') return name || 'tool';
      const filePath = input.file_path || input.filePath || input.path || input.notebook_path;
      if (input.command) return `${name}: ${String(input.command).slice(0, 120)}`;
      if (filePath) return `${name}: ${filePath}`;
      if (input.pattern) return `${name}: ${String(input.pattern).slice(0, 80)}`;
      return name || 'tool';
    }

    function Meta({ event }) {
      const bits = [];
      if (event.credits) bits.push(`credits ${formatCredits(event.credits)}`);
      if (event.durationMs) bits.push(`${(event.durationMs / 1000).toFixed(1)}s`);
      if (event.usage?.input) bits.push(`in ${event.usage.input}`);
      if (event.usage?.output) bits.push(`out ${event.usage.output}`);
      if (!event.ok) bits.push('失败');
      if (bits.length === 0) return null;
      return jsx('div', {
        style: { ...S.mono, color: C.muted, marginBottom: '10px', textAlign: 'right' },
        children: bits.join(' · '),
      });
    }

    function DiffView({ sessionId }) {
      const [state, setState] = react.useState({ loading: true });

      const load = react.useCallback(() => {
        setState({ loading: true });
        getJson(`/api/qoder.diff?sessionId=${encodeURIComponent(sessionId)}`)
          .then((data) => setState({ loading: false, data }))
          .catch((error) => setState({ loading: false, error: String(error?.message ?? error) }));
      }, [sessionId]);

      react.useEffect(load, [load]);

      if (state.loading) return jsx('div', { style: { color: C.muted }, children: '读取改动中…' });
      if (state.error) return jsx('div', { style: { color: C.danger }, children: state.error });
      const data = state.data ?? {};

      if (!data.isRepo) return jsx('div', { style: { color: C.muted }, children: '当前工作区不是 git 仓库，无法生成改动视图。' });

      const files = data.files ?? [];
      const untracked = data.untracked ?? [];

      return jsxs('div', { children: [
        jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }, children: [
          jsx('div', { style: { fontWeight: 600, fontSize: '12px' }, children: `${files.length + untracked.length} 个文件变更` }),
          jsx('button', { onClick: load, style: S.iconButton, children: '刷新' }),
        ] }),
        files.length === 0 && untracked.length === 0
          ? jsx('div', { style: { color: C.muted }, children: '没有未提交的改动。' })
          : null,
        jsx('div', { style: { marginBottom: '10px' }, children: files.map((file) =>
          jsxs('div', { style: { display: 'flex', gap: '6px', alignItems: 'baseline', padding: '2px 0' }, children: [
            jsx('span', { style: { ...S.mono, flex: '1 1 auto', wordBreak: 'break-all' }, children: file.path }),
            jsx('span', { style: { ...S.mono, color: C.add }, children: `+${file.additions}` }),
            jsx('span', { style: { ...S.mono, color: C.del }, children: `-${file.deletions}` }),
          ] }, file.path),
        ) }),
        untracked.length > 0
          ? jsx('div', { style: { marginBottom: '10px' }, children: untracked.map((filePath) =>
              jsx('div', { style: { ...S.mono, color: C.muted, padding: '2px 0', wordBreak: 'break-all' }, children: `新增 ${filePath}` }, filePath),
            ) })
          : null,
        data.patch
          ? jsx('pre', {
              style: { ...S.mono, margin: 0, padding: '8px', background: C.surface, borderRadius: '6px', whiteSpace: 'pre', overflow: 'auto', lineHeight: 1.5 },
              children: String(data.patch).split('\n').map((line, index) =>
                jsx('div', { style: patchLineStyle(line), children: line || ' ' }, index),
              ),
            })
          : null,
      ] });
    }

    function SummaryView({ sessionId }) {
      const [state, setState] = react.useState({ loading: true });

      const load = react.useCallback(() => {
        setState({ loading: true });
        getJson(`/api/qoder.summary?sessionId=${encodeURIComponent(sessionId)}`)
          .then((data) => setState({ loading: false, data }))
          .catch((error) => setState({ loading: false, error: String(error?.message ?? error) }));
      }, [sessionId]);

      react.useEffect(load, [load]);

      if (state.loading) return jsx('div', { style: { color: C.muted }, children: '读取摘要中…' });
      if (state.error) return jsx('div', { style: { color: C.danger }, children: state.error });
      const markdown = state.data?.markdown;

      return jsxs('div', { children: [
        jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }, children: [
          jsx('div', { style: { fontWeight: 600, fontSize: '12px' }, children: '会话摘要' }),
          jsx('button', { onClick: load, style: S.iconButton, children: '刷新' }),
        ] }),
        markdown
          ? jsx('pre', {
              style: { ...S.mono, margin: 0, padding: '8px', background: C.surface, borderRadius: '6px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.6 },
              children: markdown,
            })
          : jsx('div', { style: { color: C.muted }, children: '还没有摘要。完成一轮对话后会自动生成，并落盘到 .dsh/qoder/summaries/。' }),
      ] });
    }

    // ----------------------------------------------------------------- panel

    function QoderPanel() {
      const [bootstrap, setBootstrap] = react.useState({ loading: true });
      const [sessionId, setSessionId] = react.useState(null);
      const [events, setEvents] = react.useState([]);
      const [view, setView] = react.useState('chat');
      const [draft, setDraft] = react.useState('');
      const [model, setModel] = react.useState('Auto');
      const [running, setRunning] = react.useState(false);
      const [error, setError] = react.useState(null);
      const [dirtyWarning, setDirtyWarning] = react.useState(null);
      const [approvingBusy, setApprovingBusy] = react.useState(false);

      const scrollRef = react.useRef(null);
      const stickToBottom = react.useRef(true);
      const pendingForce = react.useRef(null);

      // --- bootstrap: load git state + session list, reuse or create a session
      react.useEffect(() => {
        let alive = true;
        getJson('/api/qoder.state')
          .then(async (data) => {
            if (!alive) return;
            const sessions = data.sessions ?? [];
            let id = sessions[0]?.id;
            if (!id) {
              const created = await postJson('/api/qoder.session', {});
              id = created?.session?.id;
            }
            if (!alive) return;
            setBootstrap({ loading: false, cwd: data.cwd, git: data.git });
            setSessionId(id ?? null);
          })
          .catch((err) => {
            if (alive) setBootstrap({ loading: false, error: String(err?.message ?? err) });
          });
        return () => {
          alive = false;
        };
      }, []);

      // --- tail the event log
      react.useEffect(() => {
        if (!sessionId) return undefined;
        let closed = false;
        let source = null;
        let last = 0;
        let retryTimer = null;

        setEvents([]);

        const connect = () => {
          if (closed) return;
          source = new EventSource(`/api/qoder.stream?sessionId=${encodeURIComponent(sessionId)}&from=${last}`);
          source.onmessage = (message) => {
            let event;
            try {
              event = JSON.parse(message.data);
            } catch {
              return;
            }
            if (!event || event.seq <= last) return;
            last = event.seq;
            setEvents((previous) => [...previous, event]);
          };
          source.onerror = () => {
            if (closed) return;
            source.close();
            retryTimer = setTimeout(connect, 1500);
          };
        };

        connect();

        return () => {
          closed = true;
          if (retryTimer) clearTimeout(retryTimer);
          source?.close();
        };
      }, [sessionId]);

      // --- derive status from the stream
      react.useEffect(() => {
        const lastStatus = [...events].reverse().find((event) => event.type === 'status');
        setRunning(lastStatus ? lastStatus.status === 'running' : false);
      }, [events]);

      // --- keep the transcript pinned to the newest event
      react.useEffect(() => {
        const node = scrollRef.current;
        if (!node || !stickToBottom.current) return;
        node.scrollTop = node.scrollHeight;
      }, [events]);

      const onScroll = () => {
        const node = scrollRef.current;
        if (!node) return;
        stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 60;
      };

      const send = react.useCallback(
        async (text, force) => {
          if (!sessionId || !text.trim()) return;
          setError(null);
          try {
            const result = await postJson('/api/qoder.send', {
              sessionId,
              prompt: text,
              model: model === 'Auto' ? undefined : model,
              force: Boolean(force),
            });
            if (result.needsConfirm) {
              pendingForce.current = text;
              setDirtyWarning(result.entries ?? []);
              return;
            }
            if (!result.ok) {
              setError(result.reason || result.error || '发送失败');
              return;
            }
            setDirtyWarning(null);
            pendingForce.current = null;
            setDraft('');
            stickToBottom.current = true;
          } catch (err) {
            setError(String(err?.message ?? err));
          }
        },
        [sessionId, model],
      );

      const onSubmit = () => {
        const text = draft;
        if (!text.trim() || running) return;
        void send(text, false);
      };

      const onKeyDown = (event) => {
        if (event.key !== 'Enter' || event.shiftKey) return;
        if (event.nativeEvent?.isComposing) return;
        event.preventDefault();
        onSubmit();
      };

      const onDecide = (approvalId, behavior) => {
        setApprovingBusy(true);
        postJson('/api/qoder.approve', { sessionId, approvalId, behavior })
          .catch((err) => setError(String(err?.message ?? err)))
          .finally(() => setApprovingBusy(false));
      };

      const onAbort = () => {
        postJson('/api/qoder.abort', { sessionId })
          .catch((err) => setError(String(err?.message ?? err)))
          .finally(() => undefined);
      };

      const onNewSession = async () => {
        try {
          const created = await postJson('/api/qoder.session', {});
          const id = created?.session?.id;
          if (id) {
            setSessionId(id);
            setView('chat');
            setDirtyWarning(null);
          }
        } catch (err) {
          setError(String(err?.message ?? err));
        }
      };

      // --- tool results are looked up by tool_use id when rendering cards
      const resultByToolId = react.useMemo(() => {
        const map = new Map();
        for (const event of events) {
          if (event.type === 'tool_result' && event.id) map.set(event.id, event);
        }
        return map;
      }, [events]);

      const resolvedApprovals = react.useMemo(() => {
        const set = new Set();
        for (const event of events) {
          if (event.type === 'approval_resolved') set.add(event.approvalId);
        }
        return set;
      }, [events]);

      if (bootstrap.loading) {
        return jsx('div', { style: { padding: '16px', color: C.muted, fontSize: '12px' }, children: '正在连接 Qoder…' });
      }
      if (bootstrap.error) {
        return jsx('div', { style: { padding: '16px', color: C.danger, fontSize: '12px' }, children: bootstrap.error });
      }

      const git = bootstrap.git ?? {};
      const gitLabel = git.isRepo ? `${git.branch || 'detached'}${git.sha ? ` @ ${git.sha}` : ''}` : '非 git 仓库';

      const lastTurn = [...events].reverse().find((event) => event.type === 'turn_end');
      const totalCredits = events.filter((event) => event.type === 'turn_end').reduce((sum, event) => sum + (event.credits || 0), 0);

      return jsxs('div', { style: S.root, children: [
        jsxs('div', { style: S.header, children: [
          jsx('div', { style: S.title, title: bootstrap.cwd, children: gitLabel }),
          jsx('button', { style: S.iconButton, onClick: onNewSession, title: '新建 Qoder 会话', children: '新建' }),
          running
            ? jsx('button', { style: { ...S.iconButton, borderColor: C.danger, color: C.danger }, onClick: onAbort, children: '中断' })
            : null,
        ] }),

        jsxs('div', { style: S.tabs, children: [
          jsx('button', { style: S.tab(view === 'chat'), onClick: () => setView('chat'), children: '对话' }),
          jsx('button', { style: S.tab(view === 'diff'), onClick: () => setView('diff'), children: '改动' }),
          jsx('button', { style: S.tab(view === 'summary'), onClick: () => setView('summary'), children: '摘要' }),
        ] }),

        view === 'chat'
          ? jsx('div', { style: S.body, ref: scrollRef, onScroll, children: jsxs('div', { children: [
              events.length === 0
                ? jsx('div', { style: { color: C.muted, fontSize: '12px', lineHeight: 1.7 }, children: '在下面输入需求，实际执行交给 Qoder CLI。所有额度消耗走你本机的 qoder 订阅。' })
                : null,
              events.map((event) => {
                switch (event.type) {
                  case 'user':
                    return jsx(Bubble, { text: event.text }, event.seq);
                  case 'assistant_text':
                    return jsx(AssistantText, { text: event.text }, event.seq);
                  case 'thinking':
                    return jsx('div', { style: { ...S.mono, color: C.muted, marginBottom: '6px', whiteSpace: 'pre-wrap' }, children: event.text }, event.seq);
                  case 'tool_use':
                    return jsx(ToolCard, { event, result: resultByToolId.get(event.id) }, event.seq);
                  case 'tool_result':
                    return null;
                  case 'approval_request':
                    return resolvedApprovals.has(event.approvalId)
                      ? jsx('div', { style: { ...S.mono, color: C.muted, marginBottom: '8px' }, children: `已处理授权：${event.toolName}` }, event.seq)
                      : jsx(ApprovalCard, { event, onDecide, busy: approvingBusy }, event.seq);
                  case 'turn_end':
                    return jsxs('div', { children: [jsx(Meta, { event }), null] }, event.seq);
                  case 'error':
                    return jsx('div', { style: { color: C.danger, marginBottom: '8px', whiteSpace: 'pre-wrap' }, children: event.message }, event.seq);
                  case 'notice':
                    return jsx('div', { style: { color: C.warn, marginBottom: '8px' }, children: event.text }, event.seq);
                  case 'diff_ready':
                    return jsx('div', { style: { ...S.mono, color: C.muted, marginBottom: '8px' }, children: `已捕获改动：${event.summary?.files ?? 0} 个文件` }, event.seq);
                  case 'summary':
                    return jsx('div', { style: { ...S.mono, color: C.muted, marginBottom: '8px' }, children: '摘要已更新' }, event.seq);
                  default:
                    return null;
                }
              }),
            ] }) })
          : null,

        view === 'diff' ? jsx('div', { style: S.body, children: jsx(DiffView, { sessionId }) }) : null,
        view === 'summary' ? jsx('div', { style: S.body, children: jsx(SummaryView, { sessionId }) }) : null,

        dirtyWarning
          ? jsxs('div', { style: { ...S.footer, borderTop: `1px solid ${C.warn}`, background: C.surface }, children: [
              jsx('div', { style: { fontSize: '11px', color: C.warn, marginBottom: '6px', lineHeight: 1.5 }, children: `工作区有 ${dirtyWarning.length} 处未提交改动。为保证任务可回滚，建议先提交或 stash。` }),
              jsxs('div', { style: { display: 'flex', gap: '6px' }, children: [
                jsx('button', {
                  style: S.iconButton,
                  onClick: () => {
                    setDirtyWarning(null);
                    void send(pendingForce.current ?? draft, true);
                  },
                  children: '仍然开始',
                }),
                jsx('button', { style: S.iconButton, onClick: () => setDirtyWarning(null), children: '取消' }),
              ] }),
            ] })
          : null,

        jsxs('div', { style: S.footer, children: [
          error ? jsx('div', { style: { color: C.danger, fontSize: '11px', marginBottom: '6px' }, children: error }) : null,
          jsx('textarea', {
            style: S.textarea,
            rows: 3,
            value: draft,
            placeholder: '描述要让 Qoder 做的事，Enter 发送，Shift+Enter 换行',
            onChange: (event) => setDraft(event.target.value),
            onKeyDown,
          }),
          jsxs('div', { style: S.row, children: [
            jsx('select', {
              value: model,
              onChange: (event) => setModel(event.target.value),
              style: { ...S.iconButton, padding: '3px 4px', flex: '0 0 auto' },
              children: MODELS.map((name) => jsx('option', { value: name, children: name }, name)),
            }),
            jsx('div', { style: { ...S.mono, color: C.muted, flex: '1 1 auto', textAlign: 'right' }, children: totalCredits > 0 ? `累计 ${formatCredits(totalCredits)}` : '' }),
            jsx('button', {
              onClick: onSubmit,
              disabled: running || !draft.trim(),
              style: { ...S.iconButton, background: C.accent, color: '#fff', borderColor: C.accent, opacity: running || !draft.trim() ? 0.5 : 1 },
              children: running ? '执行中' : '发送',
            }),
          ] }),
        ] }),
      ] });
    }

    // ------------------------------------------------------------------ apply

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            title: () => 'Qoder',
          }),
        'qoder-panel: tab type',
      );

      ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, QoderPanel);

      // Open once per browser session so the panel is discoverable after install,
      // without stealing focus on every reload.
      ctx.effect(() => {
        const timer = setTimeout(() => {
          try {
            if (sessionStorage.getItem('dsh.qoder.opened') === '1') return;
            sessionStorage.setItem('dsh.qoder.opened', '1');
            ctx.sidebarRight.openTab(TAB_KIND);
            console.log('[qoder] auto-opened tab');
          } catch (error) {
            console.warn('[qoder] openTab failed', error);
          }
        }, 2500);
        return () => clearTimeout(timer);
      }, 'qoder-panel: auto open');

      console.log('[qoder] tab type + body registered');
    }

    exports.apply = apply;
    // `slots` must be injected explicitly: cordis resolves services strictly, so an
    // undeclared `ctx.slots` throws on access instead of returning undefined.
    exports.inject = ['slots', 'sidebarRightTabs', 'sidebarRight'];
    return module.exports;
  },
});
