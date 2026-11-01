// 在 Node 里用桩替代浏览器环境，验证 client bundle 能被求值并导出 apply/inject
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const bundlePath = 'D:/code/dsh-plugins/packages/dsh-plugin-qoder/lib/client.js';
const code = fs.readFileSync(bundlePath, 'utf8');

const stubReact = {
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
};

const captured = [];
globalThis.window = {
  __ModuleLoader__: {
    load: (def) => captured.push(def),
  },
};
globalThis.sessionStorage = { getItem: () => '1', setItem: () => {} };

new Function(code)();

if (captured.length !== 1) {
  console.log('FAIL: expected exactly one module registration, got', captured.length);
  process.exit(1);
}

const def = captured[0];
console.log('module id =', def.id);

const fakeRequire = (name) => {
  if (name === 'react') return stubReact;
  if (name === 'react/jsx-runtime') {
    return {
      jsx: (type, props) => ({ type, props }),
      jsxs: (type, props) => ({ type, props }),
      Fragment: 'Fragment',
    };
  }
  throw new Error(`unexpected require: ${name}`);
};

const exported = def.factory(fakeRequire);
console.log('exports keys =', Object.keys(exported));
console.log('apply type   =', typeof exported.apply);
console.log('inject       =', JSON.stringify(exported.inject));

// Exercise apply() with a fake client ctx to prove registration wiring is sane
const registrations = [];
const effects = [];
const ctx = {
  effect: (fn, label) => { effects.push(label); fn(); },
  slots: { register: (key, component) => registrations.push({ kind: 'slot', key, component }) },
  sidebarRightTabs: { register: (def2) => { registrations.push({ kind: 'tab', def: def2 }); return () => {}; } },
  sidebarRight: { openTab: (kind) => console.log('openTab called with', kind) },
  logger: { warn: console.warn },
};

exported.apply(ctx);
console.log('effects  =', JSON.stringify(effects));
console.log('registrations =', JSON.stringify(registrations.map((r) => r.kind === 'slot' ? r.key : { tab: r.def.kind, title: r.def.title() })));

// First render must not throw (it only shows the loading state at this point).
const panel = registrations.find((r) => r.kind === 'slot').component;
const tree = panel();
console.log('first render node type =', typeof tree);
console.log('loading text =', JSON.stringify(tree?.props?.children));
console.log('SMOKE OK');
