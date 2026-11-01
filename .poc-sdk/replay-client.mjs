/**
 * Replay the served client bundle against a strict fake ctx.
 * Goal: reproduce the exact exception the browser boot swallows behind
 * "dsh-plugin-qoder: failed".
 */
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./qoder-bundle.js', import.meta.url), 'utf8');

const react = {
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  Fragment: Symbol('Fragment'),
  createElement: () => null,
};
const jsxRuntime = {
  jsx: (type, props) => ({ type, props }),
  jsxs: (type, props) => ({ type, props }),
  Fragment: react.Fragment,
};

const requireMap = { react, 'react/jsx-runtime': jsxRuntime };

let registered = null;
globalThis.window = {
  __ModuleLoader__: {
    load: (def) => {
      registered = def;
    },
  },
};

const trace = [];
const fakeEffect = (fn, label) => {
  trace.push(`effect:${label}`);
  const dispose = fn();
  return typeof dispose === 'function' ? dispose : () => {};
};

const ctx = {
  effect: fakeEffect,
  sidebarRightTabs: {
    register: (def) => {
      trace.push(`tabs.register:${JSON.stringify(def)}`);
      if (!def || typeof def !== 'object') throw new Error('tabs.register: definition required');
      if (!def.id) throw new Error('sidebarRight: tab type needs an id');
      if (!def.kind) throw new Error('sidebarRight: tab type needs a kind');
      if (typeof def.title !== 'function') throw new Error('sidebarRight: title must be a function');
      return () => {};
    },
  },
  sidebarRight: {
    openTab: (kind) => trace.push(`openTab:${kind}`),
  },
  slots: {
    register: (def, Component) => {
      trace.push(`slots.register:${JSON.stringify(def)} component=${typeof Component}`);
      if (!def?.name) throw new Error('slots.register: name required');
      if (typeof Component !== 'function') throw new Error('slots.register: component must be a function');
      return () => {};
    },
    inject: (name, fn) => fn(),
  },
  locale: {
    bind: () => (k) => k,
    register: () => () => {},
  },
  logger: { info: console.log, warn: console.warn, error: console.error },
};

// Evaluate the bundle exactly like the shell does.
new Function('window', 'require', 'module', 'exports', source)(globalThis.window, (spec) => {
  if (!(spec in requireMap)) throw new Error(`require: unknown module "${spec}"`);
  return requireMap[spec];
}, { exports: {} }, {});

if (!registered) throw new Error('bundle never called __ModuleLoader__.load');
console.log('loaded id:', registered.id);

const exportsObj = registered.factory((spec) => {
  if (!(spec in requireMap)) throw new Error(`require: unknown module "${spec}"`);
  return requireMap[spec];
});

console.log('exports keys:', Object.keys(exportsObj));
console.log('inject:', exportsObj.inject);

try {
  exportsObj.apply(ctx);
  console.log('APPLY OK');
  console.log(trace.join('\n'));
} catch (error) {
  console.error('APPLY FAILED:', error && error.stack ? error.stack : error);
  console.error('trace so far:\n' + trace.join('\n'));
  process.exitCode = 1;
}
