// client-harness.mjs —— 在 Node 里用桩件真实执行浏览器半边 bundle。
//
// 目的：界面渲染读不到（GUI 接口要鉴权），但**运行时错误与行为可以在 Node 里复现**。
// 这里提供最小可用的 window / document / React / configForms 桩，然后：
//   1. 加载 lib/client.js，拿到 exports
//   2. 用假 ctx 调 apply()，检查 slot 是否按宿主规则注册
//   3. **按宿主的 standardHookPropName 规则绑定 hook**，再渲染面板
//   4. 走一遍交互：改一个字段 → 保存 → 断言 mutate 收到的 op 正确
//
// 用法：node test/client-harness.mjs [path/to/client.js]
//
// ⚠️ 本 harness 存在的理由，是它抓到过两个真实致命错：
//   · hook 键名多写 `use` → 组件拿到 undefined（线上真实报错）
//   · 桩件不透传 children → 字段计数假失败，白查一轮
//   改面板后务必先跑它。

import { readFileSync } from 'node:fs';

const target = process.argv[2] ?? process.env.CLIENT_BUNDLE
  ?? new URL('../lib/client.js', import.meta.url).pathname;
const source = readFileSync(target, 'utf8');

// —— 断言收集 ——
const failures = [];
const notes = [];
function check(name, condition, detail) {
  if (condition) notes.push(`  ✓ ${name}`);
  else failures.push(`  ✗ ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

// —— 桩：document ——
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ setAttribute() {}, textContent: '' }),
  head: { appendChild: () => {} },
};

// —— 桩：React ——
// hook 游标按组件调用栈隔离，模拟 React 的 per-component hook 顺序。
let hookCursor = { index: 0, states: [] };
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => {
    const cursor = hookCursor;
    const i = cursor.index++;
    if (cursor.states[i] === undefined) cursor.states[i] = initial;
    return [cursor.states[i], (next) => { cursor.states[i] = typeof next === 'function' ? next(cursor.states[i]) : next; }];
  },
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  createContext: (initial) => ({ Provider: 'Provider', _initial: initial }),
};
React.default = React;

// —— 桩：module loader ——
let captured = null;
globalThis.window = { __ModuleLoader__: { load: (spec) => { captured = spec; } } };

// —— 加载 bundle ——
let loadError = null;
try {
  new Function('window', 'document', source)(globalThis.window, globalThis.document);
} catch (error) {
  loadError = error;
}
check('bundle 可被求值（无顶层语法/引用错误）', loadError === null, loadError?.message);
if (loadError !== null) {
  console.log(failures.join('\n'));
  process.exit(1);
}

check('调用了 window.__ModuleLoader__.load', captured !== null);
check('load 声明了 id', captured?.id === 'dsh-stage-speak', captured?.id);
check('load 提供了 factory', typeof captured?.factory === 'function');

// —— 以官方 factory 形态执行 ——
// ⚠️ 文档硬规则：不得加载任何 Harness Client 包（含 primitives）。这里只允许 react，
//    出现其它 require 一律失败 —— 这条断言就是防"又去 require primitives"。
const required = [];
const requireShim = (name) => {
  required.push(name);
  if (name === 'react') return React;
  throw new Error(`不允许的 require("${name}")：官方 practices.md §UI 禁止插件加载 Harness Client 包`);
};

let plugin = null;
let factoryError = null;
try {
  plugin = captured.factory(requireShim);
} catch (error) {
  factoryError = error;
}
check('factory 执行成功', factoryError === null, factoryError?.message);
check('只 require 了 react（未加载 primitives 等 Harness 包）',
  required.every((name) => name === 'react'), required.join(', '));

check('导出 name', plugin?.name === 'stage-speak', plugin?.name);
check('导出 apply 函数', typeof plugin?.apply === 'function');
check('导出 inject 含 slots / locale / configForms',
  ['slots', 'locale', 'configForms'].every((s) => (plugin?.inject ?? []).includes(s)),
  JSON.stringify(plugin?.inject));

// —— 假 configForms：实现 ConfigFormController 的公开面 ——
const snapshotValues = {
  enabled: true, mode: 'off', bargeInEnabled: true, duplexEchoGuard: true, bargeInOverDb: 9, bargeInOverDbPlaying: 14, bargeInReleaseMs: 600,
  duplexEnabled: true, duplexLanguage: 'zh', duplexInjectMode: 'steer',
  announceTurnEnd: true, announceTurnEndOnChat: true,
  useLlmSummary: true, announceKickoff: true, announceTodoCompleted: true,
  announceApprovals: true, announceGoalChange: false, includeSubagents: false,
  voice: '', voiceAlt: '', rate: 0, volume: 100, summaryProvider: '', summaryModel: '',
  maxChars: 120, silenceHeartbeatMs: 30000, throttleMs: 2500, minGapMs: 6000,
  stageToolCalls: 8, turnEndMinToolCalls: 1, kickoffThrottleMs: 400,
  kickoffMinTaskChars: 4, llmTimeoutMs: 15000, toolErrorPriority: 'normal',
  modelWaitMinGapMs: 60000, graceMs: 4000, speakTimeoutMs: 120000, logAnnouncements: false,
};
let snapshot = {
  status: 'ready', writable: true, revision: 7,
  value: { ...snapshotValues },
  user: { enabled: true, mode: 'half' },
  base: {},
};
const mutateCalls = [];
const fakeForm = {
  getSnapshot: () => snapshot,
  subscribe: () => () => {},
  mutate: async (ops, revision) => { mutateCalls.push({ ops, revision }); return true; },
};

const registered = [];
const fakeCtx = {
  configForms: {
    get: (id) => fakeForm,
    // ⚠️ 故意不让 whileServed 生效：一旦被调用就直接抛错。
    //    真实事故是"槽位注册被 whileServed 包住 → 条件不成立时永远不注册、且不报任何错"，
    //    表现就是插件页里什么都没有。本机可正常出面板的 dshmarket 是无条件注册的，照它。
    whileServed: () => { throw new Error('不允许用 whileServed 门禁包住槽位注册（会静默不注册）'); },
  },
  locale: { register: (ns, dict) => { fakeCtx._locale = { ns, dict }; } },
  slots: {
    inject: (_name, register) => { register(); },
    register: (options, component) => { registered.push({ options, component }); },
  },
  effect: (fn) => fn(),
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};

let applyError = null;
try {
  plugin.apply(fakeCtx);
} catch (error) {
  applyError = error;
}
check('apply() 无异常', applyError === null, applyError?.stack?.split('\n').slice(0, 3).join(' | '));
check('注册了面板槽位', registered.length === 1, `注册数=${registered.length}`);
check('槽位名为 plugins.bundle.config', registered[0]?.options?.name === 'plugins.bundle.config', registered[0]?.options?.name);
check('槽位 key 为包名（keyed slot 必需）', registered[0]?.options?.key === 'dsh-stage-speak', registered[0]?.options?.key);
check('注册了 zh + en 字典', fakeCtx._locale?.dict?.zh !== undefined && fakeCtx._locale?.dict?.en !== undefined);

// —— 按宿主规则绑定 hook ——
const injected = registered[0]?.options?.inject?.() ?? {};
const standardHookPropName = (name) => `use${name[0]?.toUpperCase() ?? ''}${name.slice(1)}`;
const boundProps = { ...injected };
for (const [name, source_] of Object.entries(injected.hooks ?? {})) {
  check(`hook 键 "${name}" 不重复带 use 前缀`, !name.startsWith('use'),
    `键名 ${name} 会被宿主翻成 use${name[0]?.toUpperCase()}${name.slice(1)}`);
  boundProps[standardHookPropName(name)] = source_;
}
check('宿主转换后存在 props.useStageSpeakCard', typeof boundProps.useStageSpeakCard === 'function' ||
  (boundProps.useStageSpeakCard !== null && typeof boundProps.useStageSpeakCard === 'object'),
  typeof boundProps.useStageSpeakCard);

const Card = registered[0]?.component;
check('卡片是组件函数', typeof Card === 'function');

const t = (key) => {
  const dict = fakeCtx._locale.dict.zh;
  const value = dict[key];
  if (value === undefined) throw new Error(`字典缺键: ${key}`);
  return value;
};

// —— 渲染（真的执行函数组件，并累计计数）——
// ⚠️ 三个坑，缺一个就得到"0 个字段"的假失败：
//   1. `createElement(Type, props, a, b)` 的 children 在 `.children`，子元素自带的在 `.props.children`；
//   2. `children: [sections, restore]` 会把数组当**单个子项**塞进来 → 必须能把数组当节点展开；
//   3. 函数组件不会自己执行，必须像 React 一样调用它。
function flatten(children, out) {
  for (const child of children) {
    if (Array.isArray(child)) flatten(child, out);
    else if (child !== null && child !== undefined && typeof child !== 'boolean') out.push(child);
  }
  return out;
}
function childrenOf(node) {
  if (Array.isArray(node)) return flatten(node, []);
  const raw = [];
  flatten(node.children ?? [], raw);
  if (node.props !== undefined) flatten([node.props.children], raw);
  return raw;
}
const counts = { Switch: 0, input: 0, select: 0, modeButton: 0, saveButton: 0 };
const domPropSeen = [];
function walk(node) {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const child of node) walk(child); return; }
  if (node.type === undefined) return;
  if (typeof node.type === 'function') {
    const parentCursor = hookCursor;
    hookCursor = { index: 0, states: parentCursor?.states ?? [] };
    let produced;
    try { produced = node.type(node.props ?? {}); } finally { hookCursor = parentCursor; }
    walk(produced);
    return;
  }
  const name = String(node.type);
  if (name === 'button') {
    if (node.props['role'] === 'switch') counts.Switch += 1;
    else if (node.props['role'] === 'radio') counts.modeButton += 1;
    else if (node.props.className?.includes('dss-btn-primary')) counts.saveButton += 1;
  }
  if (name === 'input') { counts.input += 1; domPropSeen.push(node.props); }
  if (name === 'select') { counts.select += 1; domPropSeen.push(node.props); }
  for (const child of childrenOf(node)) walk(child);
}

// 渲染时要走一遍真实的 hook 取数路径：hook(selector) 必须返回快照
const hookSource = boundProps.useStageSpeakCard;
let renderError = null;
let tree = null;
try {
  hookCursor = { index: 0, states: [] };
  // 模拟 observableHook：把 {getSnapshot,subscribe} 包成 useSelector(sel)
  const useSelector = (selector) => selector(hookSource.getSnapshot());
  tree = Card({ t, view: 'page', ...boundProps, useStageSpeakCard: useSelector });
  walk(tree);
} catch (error) {
  renderError = error;
}
check('渲染主视图无异常', renderError === null, renderError?.stack?.split('\n').slice(0, 4).join(' | '));
// 字段数 = 控件数；四档那 1 个"字段"由 4 个 radio 按钮表示，故不另计。
// v1.8.0 全双工加了 3 个字段：duplexEnabled(switch) / duplexLanguage(input) / duplexInjectMode(select)。
check('渲染出 38 个字段行', counts.Switch + counts.input + counts.select + 1 === 38,
  `switch=${counts.Switch} input=${counts.input} select=${counts.select} mode字段=1（${counts.modeButton} 个按钮）`);
check('13 个布尔字段渲染为 role=switch', counts.Switch === 13, `实际 ${counts.Switch}`);
check('2 个枚举字段渲染为 select', counts.select === 2, `实际 ${counts.select}`);
check('22 个文本/数字字段渲染为 input', counts.input === 22, `实际 ${counts.input}`);
check('四档渲染为 4 个 radio 按钮', counts.modeButton === 4, `实际 ${counts.modeButton}`);
check('number 输入框带 min 约束', domPropSeen.some((p) => p.type === 'number' && p.min !== undefined));
check('input 都有 id 且可被 label 关联', domPropSeen.every((p) => typeof p.id === 'string' && p.id.includes('plugin-config-')));

// —— summary 视图 ——
let summary = null;
let summaryError = null;
try {
  hookCursor = { index: 0, states: [] };
  summary = Card({ t, view: 'summary', ...boundProps });
} catch (error) { summaryError = error; }
check('summary 视图无异常且返回一句话', summaryError === null && typeof summary === 'string', summaryError?.message ?? typeof summary);

// —— 交互：改字段 → 保存 → 断言 mutate 的 op ——
let interactionError = null;
try {
  hookCursor = { index: 0, states: [] };
  const useSelector = (selector) => selector(hookSource.getSnapshot());
  const panel = Card({ t, view: 'page', ...boundProps, useStageSpeakCard: useSelector });
  // 面板根是 div.dss-root，children = [sections..., footer]；footer 是最后一个（带 dss-footer 类）。
  const roots = childrenOf(panel);
  const footer = roots.find((c) => c?.props?.className === 'dss-footer');
  check('面板有 footer', footer !== undefined);
  const buttons = childrenOf(footer).filter((c) => c.type === 'button');
  const saveButton = buttons.find((b) => b.props.className?.includes('dss-btn-primary'));
  check('面板有保存按钮', saveButton !== undefined);
  // 未改动时保存应禁用
  check('未改动时保存按钮禁用', saveButton?.props.disabled === true);

  // 找到三档的 radio 按钮并点击第 3 个（全双工）
  const radios = [];
  (function findRadios(node) {
    if (node === null || node === undefined || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const child of node) findRadios(child); return; }
    if (node.type === undefined) return;
    if (typeof node.type === 'function') {
      const parentCursor = hookCursor;
      hookCursor = { index: 0, states: parentCursor?.states ?? [] };
      let produced;
      try { produced = node.type(node.props ?? {}); } finally { hookCursor = parentCursor; }
      findRadios(produced);
      return;
    }
    if (String(node.type) === 'button' && node.props['role'] === 'radio') radios.push(node);
    for (const child of childrenOf(node)) findRadios(child);
  })(panel);
  check('能找到 4 个档位按钮', radios.length === 4, `实际 ${radios.length}`);
  if (radios.length === 4) {
    const half = radios[1];
    const halfClickable = half.props['aria-checked'] === false;
    if (halfClickable) half.props.onClick();
    check('能点到「半双工」档位（第 2 个 radio）', halfClickable);

    const full = radios[2];
    const fullClickable = full.props['aria-checked'] === false;
    if (fullClickable) full.props.onClick();
    check('能点到「全双工」档位（第 3 个 radio）', fullClickable);
  }
} catch (error) {
  interactionError = error;
}
check('交互流程无异常', interactionError === null, interactionError?.stack?.split('\n').slice(0, 4).join(' | '));

console.log('--- 桩件执行结果 ---');
console.log(notes.join('\n'));
if (failures.length > 0) {
  console.log('\n失败项:');
  console.log(failures.join('\n'));
  process.exit(1);
}
console.log(`\n全部通过（字段 38 个：switch ${counts.Switch} / input ${counts.input} / select ${counts.select} / mode 1）`);
