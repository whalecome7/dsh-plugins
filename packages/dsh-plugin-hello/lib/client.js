/**
 * Client half of the hello plugin.
 *
 * The browser bundle format is dsh's own module-loader wrapper (not plain ESM):
 * a bundle registers a factory, and shared modules such as `react` resolve
 * against the shell's frozen module table.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-hello',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const { jsx, jsxs } = require('react/jsx-runtime');

    const TAB_ID = 'dsh-plugin-hello/panel';
    const TAB_KIND = 'hello';

    function HelloBody() {
      const [state, setState] = react.useState({ loading: true });

      react.useEffect(() => {
        let alive = true;
        fetch('/api/hello.ping', { headers: { accept: 'application/json' } })
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
          })
          .then((data) => {
            if (alive) setState({ loading: false, data });
          })
          .catch((error) => {
            if (alive) setState({ loading: false, error: String(error) });
          });
        return () => {
          alive = false;
        };
      }, []);

      return jsxs('div', {
        style: { padding: '16px', fontSize: '13px', lineHeight: 1.6 },
        children: [
          jsx('div', {
            style: { fontWeight: 600, marginBottom: '8px' },
            children: 'Hello 插件已加载',
          }),
          jsx('div', {
            style: { color: 'var(--dsh-text-secondary, #888)', marginBottom: '8px' },
            children: '下面是从宿主端 /api/hello.ping 拿到的真实数据：',
          }),
          jsx('pre', {
            style: {
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              margin: 0,
              padding: '10px',
              borderRadius: '6px',
              background: 'var(--dsh-surface-raised, rgba(127,127,127,.1))',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: '12px',
            },
            children: JSON.stringify(state, null, 2),
          }),
        ],
      });
    }

    function apply(ctx) {
      console.log('[hello-plugin] client apply() called');

      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            title: () => 'Hello',
          }),
        'hello-plugin: tab type',
      );

      ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, HelloBody);

      console.log('[hello-plugin] tab type + body registered');

      ctx.effect(() => {
        const timer = setTimeout(() => {
          try {
            ctx.sidebarRight.openTab(TAB_KIND);
            console.log('[hello-plugin] openTab ok');
          } catch (error) {
            console.warn('[hello-plugin] openTab failed (likely no session on screen yet)', error);
          }
        }, 2000);
        return () => clearTimeout(timer);
      }, 'hello-plugin: auto open');
    }

    exports.apply = apply;
    exports.inject = ['sidebarRightTabs', 'sidebarRight'];
    return module.exports;
  },
});
