// offline.mjs — 脱离 DSH 运行时的端到端逻辑测试。
//
// 覆盖：活动缓冲 / 阶段边界判定 / 防抖与最小间隔 / 优先级插队 / LLM 摘要与降级 /
//       子代理过滤 / 语音队列合并 / 文本清洗。
//
// 跑法：node test/offline.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { cleanForSpeech, truncateForSpeech } from '../lib/clean.js';
import { APPROVAL_SIGNAL, ASK_USER_SIGNAL, PRIORITY, cleanApprovalReason, closerFor, createSessionState, describeTool, drain, formatDuration, noteEvent, pendingWorkLine, readTodos, toolHint, textOfMessage, waitingLine } from '../lib/activity.js';
import { ruleSummary, buildPrompt } from '../lib/summarize.js';
import { buildSpawnSpec, buildSpeechArgv, createSpeechEngine, resolveEnginePath } from '../lib/engine.js';
import { createAudioCore } from '../lib/audio-core.js';
import { createDuplex } from '../lib/duplex.js';
import { composeAnnouncement, expandHome, readField, resolveConfig } from '../lib/index.js';

let passed = 0;
let failed = 0;

async function test(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${label}\n      ${error?.message ?? error}`);
  }
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 断言一份 spawn 参数符合 `SubprocessSpawnSpec`。
 *
 * 契约要求：argv / cwd / stdio / graceMs 全部必填，且
 * `SubprocessOutputMode` 只允许 'pipe' | 'inherit' | { maxBytes }（'ignore' 仅 stdin）。
 * 之前就是因为漏了 cwd、又把 stdout 写成 'ignore'，才在真机上空转。
 */
function assertConformantSpawnSpec(spec) {
  assert.ok(spec && typeof spec === 'object', 'spec 必须是对象');
  assert.ok(Array.isArray(spec.argv) && spec.argv.length > 0, 'argv 必须是非空数组');
  assert.equal(typeof spec.cwd, 'string', 'cwd 必填且必须是字符串');
  assert.ok(spec.cwd.length > 0, 'cwd 不能是空串');
  assert.equal(typeof spec.graceMs, 'number', 'graceMs 必填且必须是数字');
  assert.ok(spec.stdio && typeof spec.stdio === 'object', 'stdio 必填');
  assert.ok(['ignore', 'pipe'].includes(spec.stdio.stdin) || typeof spec.stdio.stdin === 'object', 'stdin 模式非法');
  for (const key of ['stdout', 'stderr']) {
    const mode = spec.stdio[key];
    const ok = mode === 'pipe' || mode === 'inherit'
      || (typeof mode === 'object' && mode !== null && Number.isFinite(mode.maxBytes));
    assert.ok(ok, `${key} 模式非法（'ignore' 只允许用于 stdin）：${JSON.stringify(mode)}`);
  }
  if (spec.signal !== undefined) assert.ok(spec.signal instanceof AbortSignal, 'signal 必须是 AbortSignal');
  if (spec.env !== undefined) assert.ok(typeof spec.env === 'object' && spec.env !== null, 'env 必须是对象');
}

/**
 * 造一个假的子进程服务，记录每次 spawn 的 argv，并校验契约。
 *
 * 两类子进程分开记：
 *   `calls`     —— **单向**播报子进程（wrapper / say）：stdin 'ignore'，只关心它念了什么。
 *   `coreCalls` —— **双向**音频内核：stdin 与 stdout 都是 'pipe'（JSON Lines 协议）。
 * 分开是必要的：内核是 apply 时就拉起的常驻进程，若混进 `calls`，所有
 * "播报了几次"的断言都会被它污染（它不是一个播报）。
 *
 * @param {object} [options] - hold=子进程存活毫秒；throwOnSpawn=强制抛错；
 *   stdoutText=单向子进程的 stdout 内容；exitCode=退出码。
 */
function fakeSubprocess({ hold = 0, throwOnSpawn = null, stdoutText = '', exitCode = 0 } = {}) {
  const calls = [];
  const coreCalls = [];
  const kernels = [];
  return {
    calls,
    coreCalls,
    kernels,
    resolveExecutable: async (command) => `/usr/bin/${command}`,
    spawn(spec) {
      assertConformantSpawnSpec(spec);
      if (throwOnSpawn !== null) throw throwOnSpawn;
      // 双向管道 = 音频内核：给它一对真的 PassThrough，让客户端能正常读写协议。
      if (spec.stdio?.stdin === 'pipe' && spec.stdio?.stdout === 'pipe') {
        coreCalls.push(spec);
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        // 记下来，端到端用例要**从内核侧**发 utterance-file 事件。
        kernels.push({ spec, stdin, stdout, stderr });
        return {
          stdin,
          stdout,
          stderr,
          done: new Promise(() => {}), // 常驻：不主动退出
          collected: {},
          terminate: () => {},
        };
      }
      calls.push(spec);
      let resolveDone;
      const done = new Promise((resolve) => { resolveDone = resolve; });
      const finish = () => resolveDone({ exitCode, signal: null });
      if (hold === 0) setTimeout(finish, 0);
      else setTimeout(finish, hold);
      return {
        done,
        collected: {
          stdout: { readFrom: () => ({ text: stdoutText }) },
          stderr: { readFrom: () => ({ text: '' }) },
        },
        terminate: () => { resolveDone({ exitCode: null, signal: 'SIGTERM' }); },
      };
    },
  };
}

/** 造一个假的 cordis 上下文。 */
function fakeCtx({ subprocess, llm, defaultSelection, agents, speechToText } = {}) {
  const handlers = new Map();
  const disposers = [];
  return {
    handlers,
    subprocess: subprocess ?? fakeSubprocess(),
    logger: { info: () => {}, warn: () => {} },
    get(name) {
      if (name === 'llm') return llm;
      if (name === 'agents') return agents;
      if (name === 'speechToText') return speechToText;
      if (name === 'agentDefaultModel') return defaultSelection === undefined ? undefined : { currentSelection: () => defaultSelection };
      return undefined;
    },
    on(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    effect(callback) {
      const disposer = callback();
      if (typeof disposer === 'function') disposers.push(disposer);
    },
    disposeAll() { for (const disposer of disposers) disposer(); },
    emit(name, ...args) { for (const handler of handlers.get(name) ?? []) handler(...args); },
  };
}

function fakeSession(id = 's1', header = {}) {
  return { id, header, requestContext: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }) };
}

/** 造一个可用的假 llm：把最后一条 user 文本回显成固定摘要。 */
function fakeLlm({ text = '阶段完成，进度正常。', fail = false, throwAt = null } = {}) {
  const seen = [];
  return {
    seen,
    stream(options) {
      seen.push(options);
      return (async function* generate() {
        if (throwAt === 'call') throw new Error('llm exploded');
        if (!fail) yield { type: 'text-delta', index: 0, text };
        yield { type: 'finish', reason: fail ? { kind: 'error', failure: { message: 'boom', code: 'X' } } : { kind: 'stop' } };
      })();
    },
  };
}

console.log('\n── 1. 文本清洗 ──');

await test('剥掉 markdown 结构，保留可读内容', () => {
  const out = cleanForSpeech('## 标题\n\n做了**三件事**，见 `main.js` 和 [文档](https://a.b/c)。\n\n- 一\n- 二\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n完成 🎉');
  assert.ok(!out.includes('#'), '不该残留标题符号');
  assert.ok(!out.includes('|'), '不该残留表格竖线');
  assert.ok(!out.includes('https://'), '不该残留 URL');
  assert.ok(!out.includes('🎉'), '不该残留 emoji');
  assert.ok(out.includes('三件事'), '应保留加粗内的文字');
  assert.ok(out.includes('文档'), '应保留链接文字');
});

await test('代码块替换成占位语而不是逐字念', () => {
  const out = cleanForSpeech('看这段：\n\n```js\nconst secret = 42\n```\n\n就这样');
  assert.ok(out.includes('代码略'), `期望含占位语，实际：${out}`);
  assert.ok(!out.includes('secret'), '代码内容不该被念出来');
});

await test('截断落在句末而不是半句', () => {
  const text = '第一句话比较长一些。第二句话也不短。第三句话更长一些。';
  const out = truncateForSpeech(text, 20);
  assert.ok(out.length <= 21, `不该超过上限太多：${out.length}`);
  assert.ok(out.endsWith('。'), `应落在句末：${out}`);
});

console.log('\n── 2. 阶段边界判定 ──');

const CFG = { stageToolCalls: 3, announceTodoCompleted: true, announceTurnEnd: true, announceApprovals: true, announceGoalChange: false, turnEndMinToolCalls: 1, toolErrorIgnoreCodes: ['FS_NOT_OBSERVED', 'FS_STALE_VERSION'], toolErrorPriority: 'normal' };

await test('todo 首次出现已完成项 → todo-completed', () => {
  const state = createSessionState('a');
  assert.equal(noteEvent(state, { type: 'turn/start', data: { turn: 1 } }, CFG), null);
  const hit = noteEvent(state, { type: 'todo/write', data: { todos: [{ content: '写代码', status: 'completed' }, { content: '测试', status: 'pending' }] } }, CFG);
  assert.equal(hit?.reason, 'todo-completed');
});

await test('todo 重复写同一份快照不重复触发', () => {
  const state = createSessionState('a');
  const ev = { type: 'todo/write', data: { todos: [{ content: 'x', status: 'completed' }] } };
  assert.equal(noteEvent(state, ev, CFG)?.reason, 'todo-completed');
  assert.equal(noteEvent(state, ev, CFG), null, '第二次不该再触发');
});

await test('累计工具调用达到阈值 → tool-milestone', () => {
  const state = createSessionState('a');
  const call = { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"ls"}' } };
  assert.equal(noteEvent(state, call, CFG), null);
  assert.equal(noteEvent(state, call, CFG), null);
  assert.equal(noteEvent(state, call, CFG)?.reason, 'tool-milestone');
});

await test('工具报错 → 普通优先级（真实数据校准后不再打断）', () => {
  const state = createSessionState('a');
  const hit = noteEvent(state, { type: 'tool/result', data: { error: { name: 'Error', code: 'E_BOOM' } } }, CFG);
  assert.equal(hit?.reason, 'tool-error');
  assert.equal(hit?.priority, PRIORITY.normal);
});

await test('按设计可自愈的 FsError 不触发播报（真实会话回放校准）', () => {
  for (const code of ['FS_NOT_OBSERVED', 'FS_STALE_VERSION']) {
    const state = createSessionState('a');
    const hit = noteEvent(state, { type: 'tool/result', data: { error: { name: 'FsError', code } } }, CFG);
    assert.equal(hit, null, `${code} 不该触发播报`);
  }
});

await test('真实失败类 FsError 仍然播报并带上错误码', () => {
  const state = createSessionState('a');
  const hit = noteEvent(state, { type: 'tool/result', data: { error: { name: 'FsError', code: 'FS_NOT_FOUND' } } }, CFG);
  assert.equal(hit?.reason, 'tool-error');
  assert.equal(hit?.code, 'FS_NOT_FOUND');
});

await test('toolErrorPriority=high 时恢复打断行为', () => {
  const state = createSessionState('a');
  const hit = noteEvent(state, { type: 'tool/result', data: { error: { code: 'X' } } }, { ...CFG, toolErrorPriority: 'high' });
  assert.equal(hit?.priority, PRIORITY.high);
});

await test('无结构化 error 但 isError 的失败也播报（如 skill 不存在）', () => {
  const state = createSessionState('a');
  const hit = noteEvent(state, { type: 'tool/result', data: { message: { isError: true } } }, CFG);
  assert.equal(hit?.reason, 'tool-error');
});

await test('审批请求 → high 优先级；关掉开关则静默', () => {
  const state = createSessionState('a');
  const hit = noteEvent(state, { type: 'approval/asked', data: { toolName: 'bash', reason: '要写文件' } }, CFG);
  assert.equal(hit?.reason, 'approval');
  assert.equal(hit?.priority, PRIORITY.high);

  const off = createSessionState('b');
  assert.equal(noteEvent(off, { type: 'approval/asked', data: { toolName: 'bash' } }, { ...CFG, announceApprovals: false }), null);
});

await test('空转的一轮不播报（turnEndMinToolCalls=1）', () => {
  const state = createSessionState('a');
  noteEvent(state, { type: 'turn/start', data: { turn: 1 } }, CFG);
  assert.equal(noteEvent(state, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }, CFG), null);
});

await test('干过活的一轮 → turn-end', () => {
  const state = createSessionState('a');
  noteEvent(state, { type: 'turn/start', data: { turn: 1 } }, CFG);
  noteEvent(state, { type: 'tool/call', data: { name: 'read' } }, CFG);
  assert.equal(noteEvent(state, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }, CFG)?.reason, 'turn-end');
});

await test('turn/start 重置完成计数基线', () => {
  const state = createSessionState('a');
  const ev = { type: 'todo/write', data: { todos: [{ content: 'x', status: 'completed' }] } };
  assert.equal(noteEvent(state, ev, CFG)?.reason, 'todo-completed');
  noteEvent(state, { type: 'turn/start', data: { turn: 2 } }, CFG);
  assert.equal(noteEvent(state, ev, CFG)?.reason, 'todo-completed', '新轮次应重新算完成数');
});

await test('drain 抽干缓冲并清零计数', () => {
  const state = createSessionState('a');
  noteEvent(state, { type: 'user/message', data: { content: [{ type: 'text', text: '帮我修 bug' }] } }, CFG);
  noteEvent(state, { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"pytest"}' } }, CFG);
  const snap = drain(state);
  assert.equal(snap.task, '帮我修 bug');
  assert.equal(snap.toolCalls, 1);
  assert.ok(snap.lines.some((line) => line.includes('pytest')), `工具提示应带上命令：${snap.lines}`);
  const again = drain(state);
  assert.equal(again.lines.length, 0, '第二次抽干应为空');
  assert.equal(again.toolCalls, 0);
});

await test('容错：畸形事件不抛异常', () => {
  const state = createSessionState('a');
  for (const bad of [null, undefined, {}, { type: 'nope' }, { type: 'todo/write' }, { type: 'todo/write', data: { todos: 'x' } }, { type: 'tool/call' }]) {
    assert.doesNotThrow(() => noteEvent(state, bad ?? {}, CFG));
  }
});

console.log('\n── 3. 规则摘要兜底 ──');

await test('审批场景念出要批准什么', () => {
  const out = ruleSummary({ lines: ['需要审批 bash：要写系统文件'], toolCalls: 0 }, 'approval');
  assert.ok(out.includes('要写系统文件'), out);
});

await test('turn-end 带上步数', () => {
  assert.ok(ruleSummary({ lines: [], toolCalls: 5 }, 'turn-end').includes('5'));
});

await test('提示词里带任务与活动清单', () => {
  const prompt = buildPrompt({ task: '修 bug', lines: ['bash(pytest)'], toolCalls: 1 }, 'turn-end');
  assert.ok(prompt.includes('修 bug'));
  assert.ok(prompt.includes('bash(pytest)'));
});

console.log('\n── 4. 语音 argv 构造 ──');

await test('macOS：带音色与语速', () => {
  const { argv } = buildSpeechArgv('darwin', '/usr/bin/say', '你好', { voice: 'Tingting', rate: 200, volume: 100 });
  assert.deepEqual(argv, ['/usr/bin/say', '-v', 'Tingting', '-r', '200', '你好']);
});

await test('macOS：留空则不传音色，跟随系统默认', () => {
  const { argv } = buildSpeechArgv('darwin', '/usr/bin/say', '你好', { voice: '', rate: 0, volume: 100 });
  assert.deepEqual(argv, ['/usr/bin/say', '你好']);
});

await test('Windows：文本走环境变量，避免引号地狱', () => {
  const { argv, env } = buildSpeechArgv('win32', 'powershell', '他说"你好"', { voice: '', rate: 2, volume: 50 });
  assert.equal(env.STAGE_SPEAK_TEXT, '他说"你好"');
  assert.ok(!argv.includes('他说"你好"'), '文本不该出现在 argv 里');
  assert.ok(argv.join(' ').includes('Rate = 2'));
});

console.log('\n── 4b. spawn 参数必须符合 SubprocessSpawnSpec ──');

await test('buildSpawnSpec 产出合规参数（cwd 必填、stdout 不能是 ignore）', () => {
  const spec = buildSpawnSpec(['/usr/bin/say', '你好'], undefined, new AbortController().signal, { cwd: '', graceMs: 4000 });
  assertConformantSpawnSpec(spec);
  assert.equal(spec.stdio.stdin, 'ignore');
  assert.deepEqual(spec.stdio.stdout, { maxBytes: 4096 });
  assert.deepEqual(spec.stdio.stderr, { maxBytes: 4096 });
});

await test('cwd 留空回落到用户主目录，非空则原样使用', () => {
  const fallback = buildSpawnSpec(['/bin/echo'], undefined, undefined, { cwd: '', graceMs: 1 });
  assert.ok(fallback.cwd.startsWith('/'), `应是绝对路径：${fallback.cwd}`);
  const explicit = buildSpawnSpec(['/bin/echo'], undefined, undefined, { cwd: '/tmp', graceMs: 1 });
  assert.equal(explicit.cwd, '/tmp');
});

await test('非法 graceMs 被兜底为 4000', () => {
  assert.equal(buildSpawnSpec(['/bin/echo'], undefined, undefined, { cwd: '', graceMs: Number.NaN }).graceMs, 4000);
  assert.equal(buildSpawnSpec(['/bin/echo'], undefined, undefined, { cwd: '', graceMs: 0 }).graceMs, 4000);
});

console.log('\n── 5. 语音队列语义 ──');

await test('同一时刻只有一个朗读进程', async () => {
  const subprocess = fakeSubprocess({ hold: 30 });
  const engine = createSpeechEngine({ subprocess, logger: { warn: () => {} }, config: { engine: '', voice: '', rate: 0, volume: 100, graceMs: 10, speakTimeoutMs: 5000 } });
  engine.speak('第一句');
  engine.speak('第二句');
  engine.speak('第三句');
  await tick(5);
  assert.equal(subprocess.calls.length, 1, `应只启动一个进程，实际 ${subprocess.calls.length}`);
  await tick(200);
  engine.dispose();
});

await test('忙时普通播报合并，只念最新一条', async () => {
  const subprocess = fakeSubprocess({ hold: 40 });
  const engine = createSpeechEngine({ subprocess, logger: { warn: () => {} }, config: { engine: '', voice: '', rate: 0, volume: 100, graceMs: 10, speakTimeoutMs: 5000 } });
  engine.speak('旧的普通播报');
  await tick(5);
  engine.speak('中间那条');
  engine.speak('最新那条');
  await tick(300);
  const spoken = subprocess.calls.map((call) => call.argv.at(-1));
  assert.ok(spoken.includes('最新那条'), `应念最新一条：${JSON.stringify(spoken)}`);
  assert.ok(!spoken.includes('中间那条'), '中间那条应被合并丢弃');
  engine.dispose();
});

await test('high 优先级打断当前播报', async () => {
  const subprocess = fakeSubprocess({ hold: 200 });
  const engine = createSpeechEngine({ subprocess, logger: { warn: () => {} }, config: { engine: '', voice: '', rate: 0, volume: 100, graceMs: 10, speakTimeoutMs: 5000 } });
  engine.speak('慢慢念的长摘要', PRIORITY.normal);
  await tick(10);
  engine.speak('需要你审批', PRIORITY.high);
  await tick(60);
  const spoken = subprocess.calls.map((call) => call.argv.at(-1));
  assert.ok(spoken.includes('需要你审批'), `急事应被念出：${JSON.stringify(spoken)}`);
  assert.equal(engine.stats().interrupted, 1);
  await tick(300);
  engine.dispose();
});

await test('spawn 抛错时不再静默：lastError 有值且 onError 被调用', async () => {
  const subprocess = fakeSubprocess({ throwOnSpawn: new Error('cwd is required') });
  const events = [];
  const engine = createSpeechEngine({
    subprocess,
    logger: { warn: () => {} },
    config: { engine: '', voice: '', rate: 0, volume: 100, cwd: '', graceMs: 10, speakTimeoutMs: 5000 },
    onError: (kind, detail) => events.push({ kind, detail }),
  });
  engine.speak('这句会失败');
  await tick(40);
  assert.equal(events.length, 1, '应上报一次错误');
  assert.equal(events[0].kind, 'speak-error');
  assert.match(events[0].detail, /cwd is required/);
  assert.match(String(engine.stats().lastError), /cwd is required/);
  assert.equal(engine.stats().spoken, 0);
  engine.dispose();
});

console.log('\n── 5c. barge-in（音频内核接入）──');

/** 引擎测试共用的最小配置。 */
const ENGINE_CFG = { engine: '', voice: '', rate: 0, volume: 100, graceMs: 10, speakTimeoutMs: 5000 };

/** 造一个假音频内核客户端：记录 play/stop，并允许手动 emit 事件（模拟内核上报 voice）。 */
function fakeAudioCore({ holdPlay = false } = {}) {
  const handlers = new Map();
  const played = [];
  const stops = [];
  let disposed = false;
  return {
    played,
    stops,
    isDisposed: () => disposed,
    on(kind, handler) {
      const list = handlers.get(kind) ?? [];
      list.push(handler);
      handlers.set(kind, list);
    },
    emit(kind, payload) { for (const handler of handlers.get(kind) ?? []) handler(payload); },
    play(audioPath, id) {
      played.push({ path: audioPath, id });
      // holdPlay：模拟"内核正在播"，只有 stop/超时才会 settle。
      return holdPlay ? new Promise(() => {}) : Promise.resolve({ status: 'finished', id });
    },
    stop(reason) { stops.push(reason); },
    dispose() { disposed = true; },
    stats: () => ({ alive: true, ready: true, playing: false }),
  };
}

/** 造一个会真的给双向管道的 fake subprocess，用来单测 lib/audio-core.js 的协议。 */
function fakeStreamSubprocess() {
  const calls = [];
  const written = [];
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdin.on('data', (chunk) => written.push(String(chunk)));
  return {
    calls,
    written,
    stdin,
    stdout,
    stderr,
    resolveExecutable: async (command) => `/usr/bin/${command}`,
    spawn(spec) {
      assertConformantSpawnSpec(spec);
      calls.push(spec);
      return { stdin, stdout, stderr, done: new Promise(() => {}), collected: {}, terminate: () => {} };
    },
  };
}

await test('内核路径①：audioCore 为 null 时完全走老路径（wrapper 自播）', async () => {
  const subprocess = fakeSubprocess();
  const engine = createSpeechEngine({ subprocess, logger: { warn: () => {} }, config: ENGINE_CFG });
  engine.speak('老路径照旧');
  await tick(40);
  assert.equal(subprocess.calls.length, 1, `应只播一次：${subprocess.calls.length}`);
  assert.equal(subprocess.calls[0].env, undefined, '老路径不该下发 MMX_SYNTH_ONLY');
  assert.equal(subprocess.calls[0].argv.at(-1), '老路径照旧');
  assert.equal(engine.stats().spoken, 1);
  engine.dispose();
});

await test('内核路径②：给了 audioCore 就走 synth-only 合成 + 内核播放', async () => {
  const subprocess = fakeSubprocess({ stdoutText: '/tmp/dsh-stage-speak-test.mp3\n' });
  const core = fakeAudioCore();
  const engine = createSpeechEngine({ subprocess, logger: { warn: () => {} }, config: ENGINE_CFG, audioCore: core });
  engine.speak('交给内核播');
  await tick(60);
  assert.equal(subprocess.calls.length, 1, '合成仍是一次子进程调用');
  assert.equal(subprocess.calls[0].env?.MMX_SYNTH_ONLY, '1', 'wrapper 必须只合成不播放');
  assert.equal(subprocess.calls[0].argv.at(-1), '交给内核播', '文本仍走 argv');
  assert.equal(subprocess.coreCalls.length, 0, '内核由 index 侧创建，engine 不该再 spawn 内核');
  assert.equal(core.played.length, 1, '应把合成结果交给内核播');
  assert.equal(core.played[0].path, '/tmp/dsh-stage-speak-test.mp3');
  assert.equal(engine.stats().spoken, 1);
  engine.dispose();
});

await test('内核路径③：voice 事件 → onBargeIn + interrupt（清队列、内核收 stop）', async () => {
  const subprocess = fakeSubprocess({ stdoutText: '/tmp/a.mp3\n' });
  const core = fakeAudioCore({ holdPlay: true });
  const barges = [];
  const engine = createSpeechEngine({
    subprocess,
    logger: { warn: () => {} },
    config: ENGINE_CFG,
    audioCore: core,
    onBargeIn: (event) => barges.push(event),
  });
  engine.speak('正在念的一句');
  engine.speak('还在排队的下一句');
  await tick(60);
  assert.equal(core.played.length, 1, `第一条应已交给内核：${core.played.length}`);

  core.emit('voice', { ev: 'voice', level: -44.9 });
  await tick(10);
  assert.equal(barges.length, 1, 'onBargeIn 必须被调用');
  assert.equal(barges[0].level, -44.9, '事件原样透传给 onBargeIn');
  assert.ok(core.stops.includes('barge-in'), `内核应收到 stop(barge-in)：${JSON.stringify(core.stops)}`);
  assert.equal(engine.stats().queued, 0, '在排队的播报必须让路');
  assert.ok(engine.stats().interrupted >= 1, '应记一次打断');
  engine.dispose();
});

await test('内核路径④：interrupt 清空队列且不抛错（有/无内核两种）', async () => {
  const subprocess = fakeSubprocess({ hold: 200 });
  const plain = createSpeechEngine({ subprocess, logger: { warn: () => {} }, config: ENGINE_CFG });
  plain.speak('第一句');
  plain.speak('第二句');
  await tick(5);
  assert.doesNotThrow(() => plain.interrupt('barge-in'));
  assert.equal(plain.stats().queued, 0, '队列应被清空');
  assert.ok(plain.stats().dropped >= 1, '被清掉的应计入 dropped');
  plain.dispose();

  const subprocess2 = fakeSubprocess({ stdoutText: '/tmp/b.mp3\n' });
  const core = fakeAudioCore({ holdPlay: true });
  const kernel = createSpeechEngine({ subprocess: subprocess2, logger: { warn: () => {} }, config: ENGINE_CFG, audioCore: core });
  kernel.speak('甲');
  kernel.speak('乙');
  await tick(60);
  assert.doesNotThrow(() => kernel.interrupt('barge-in'));
  assert.equal(kernel.stats().queued, 0, '内核路径下队列同样要清空');
  assert.ok(core.stops.includes('barge-in'));
  kernel.dispose();
});

await test('内核客户①：内核不存在时返回 null 并留日志（优雅降级）', () => {
  const warns = [];
  const core = createAudioCore({
    subprocess: fakeSubprocess(),
    logger: { warn: (message) => warns.push(String(message)) },
    config: { audioCorePath: './engine/definitely-not-built', cwd: '', graceMs: 10 },
  });
  assert.equal(core, null, '内核不存在必须返回 null，而不是半个可用对象');
  assert.ok(warns.some((message) => message.includes('内核不存在')), `应 warn：${JSON.stringify(warns)}`);
});

await test('内核客户②：解析 JSON Lines、派发事件、play/stop/quit 走协议', async () => {
  const subprocess = fakeStreamSubprocess();
  const voices = [];
  let readyCount = 0;
  // 用一个**一定存在**的包内文件当替身：本用例只验证客户端协议，spawn 是假的。
  // （真内核 engine/audio-core 是编译产物、不入库，不能当测试前置条件。）
  const core = createAudioCore({
    subprocess,
    logger: { warn: () => {} },
    config: { audioCorePath: './engine/minimax-speak.sh', cwd: '', graceMs: 10, bargeInOverDb: 11, bargeInReleaseMs: 640 },
    onReady: () => { readyCount += 1; },
  });
  assert.ok(core !== null, '内核存在时应返回客户端');
  assert.equal(subprocess.calls.length, 1);
  assert.ok(subprocess.calls[0].cwd.length > 0, 'cwd 必填（漏了 spawn 会同步抛错）');
  assert.equal(subprocess.calls[0].env.VAD_OVER_DB, '11', 'bargeInOverDb 应下发 VAD_OVER_DB');
  assert.equal(subprocess.calls[0].env.VAD_RELEASE_FRAMES, '30', '640ms ≈ 30 帧（1024 帧 @48k）');

  core.on('voice', (event) => voices.push(event));
  subprocess.stdout.write(`${JSON.stringify({ ev: 'ready', sampleRate: 48000 })}\n`);
  subprocess.stdout.write('这不是 JSON\n');
  subprocess.stdout.write(`${JSON.stringify({ ev: 'voice', level: -44.9 })}\n`);
  await tick(10);
  assert.equal(core.stats().ready, true, '应收到 ready');
  assert.equal(readyCount, 1, '命名回调 onReady 与 on(kind) 两种写法都要生效');
  assert.equal(voices.length, 1, '非 JSON 行必须被跳过，不能污染事件流');
  assert.equal(voices[0].level, -44.9);

  const playing = core.play('/tmp/abc.mp3', 'say-1');
  assert.ok(subprocess.written.join('').includes('"cmd":"play"'), 'play 应写成 JSON Lines');
  subprocess.stdout.write(`${JSON.stringify({ ev: 'finished', id: 'say-1' })}\n`);
  const outcome = await playing;
  assert.equal(outcome.status, 'finished', 'finished 应 settle 对应的 play');
  core.stop('barge-in');
  assert.ok(subprocess.written.join('').includes('"reason":"barge-in"'), 'stop 应带上 reason');
  core.dispose();
  assert.ok(subprocess.written.join('').includes('"cmd":"quit"'), 'dispose 应下发 quit');
  assert.equal(core.stats().alive, false);
});

console.log('\n── 5d. 全双工（mode: full：分句落盘 → 本地识别 → 注入）──');

/**
 * 造一个假 speechToText：契约与官方 sensevoice provider 对齐（不是想当然写的）。
 * 已核实的官方实现（app.asar 里 @deepseek-ai/dsh-experimental-speech-to-text + -sensevoice）：
 *   - `resolve({audio, language})` 对 language 有**白名单校验**，不在名单里直接抛；
 *   - `transcribe(spec, signal)` 第一行就是 `signal.throwIfAborted()` —— signal 必填；
 *   - 返回 `{ text, audioSeconds, inferenceSeconds }`（zod `.strict()`）。
 */
function fakeSpeechToText({ text = '帮我把构建脚本跑一遍', fail = false } = {}) {
  const resolved = [];
  const transcribed = [];
  const languages = ['auto', 'zh', 'en', 'yue', 'ja', 'ko'];
  return {
    resolved,
    transcribed,
    resolve(request) {
      resolved.push(request);
      if (!languages.includes(request.language)) {
        throw new Error(`Speech provider sensevoice-local does not support language: ${request.language}`);
      }
      return { provider: { info: { id: 'sensevoice-local' } }, audio: request.audio, language: request.language };
    },
    async transcribe(spec, signal) {
      signal.throwIfAborted();
      transcribed.push(spec);
      if (fail) throw new Error('inference exploded');
      return { text, audioSeconds: 1.2, inferenceSeconds: 0.3 };
    },
  };
}

/** 造一个假 agents：记录 steer / followup。 */
function fakeAgents() {
  const steered = [];
  const followed = [];
  return {
    steered,
    followed,
    get(id) {
      return {
        steer: (message) => steered.push({ id, message }),
        followup: (message) => followed.push({ id, message }),
      };
    },
  };
}

/**
 * 断言注入的是**完整 UserMessage**。
 *
 * 依据是 `dsh-session` 的 `assertMessageEventShape()`（我逐字读过）：
 * `id` 非空 string、`role === 'user'`、`source.kind` 非空 string、`content` 必须是数组。
 * 传纯字符串会在 `user/message` 事件落库时被直接拒。
 */
function assertUserMessageShape(message) {
  assert.ok(message !== null && typeof message === 'object', '必须是对象（纯字符串会被 dsh-session 拒）');
  assert.equal(typeof message.id, 'string', 'id 必须是 string');
  assert.ok(message.id.length > 0, 'id 不能是空串');
  assert.equal(message.role, 'user', 'role 必须是 user');
  assert.ok(Array.isArray(message.content), 'content 必须是数组');
  assert.equal(message.content[0]?.type, 'text', 'content[0] 必须是 text 块');
  assert.equal(typeof message.content[0]?.text, 'string');
  assert.equal(typeof message.source?.kind, 'string', 'source.kind 必须存在');
  assert.ok(message.source.kind.length > 0, 'source.kind 不能是空串');
}

/** 全双工单测的公共依赖：假的读/删（避免测试依赖真实文件）。 */
function duplexHarness({
  text = '帮我把构建脚本跑一遍',
  fail = false,
  missingFile = false,
  service = true,
  config = {},
  utteranceDir = '',
  recentSpeech = undefined,
} = {}) {
  const removed = [];
  const read = [];
  const speechToText = fakeSpeechToText({ text, fail });
  const agents = fakeAgents();
  const duplex = createDuplex({
    speechToText: service ? speechToText : undefined,
    logger: { warn: () => {} },
    config: { duplexLanguage: 'zh', duplexInjectMode: 'steer', ...config },
    utteranceDir,
    resolveTarget: () => ({ sessionId: 's1', agent: agents.get('s1') }),
    ...(recentSpeech === undefined ? {} : { recentSpeech }),
    readAudio: async (path) => {
      read.push(path);
      if (missingFile) throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
      return Buffer.from('RIFF....WAVE');
    },
    removeAudio: async (path) => { removed.push(path); },
  });
  return { duplex, speechToText, agents, removed, read };
}

await test('全双工①：识别文本经 steer 注入，且是完整 UserMessage', async () => {
  const h = duplexHarness();
  const outcome = await h.duplex.handle({ path: '/tmp/asr/utt-000001.wav', id: 'utt-000001.wav', seconds: 2.1 });
  assert.equal(outcome.status, 'injected', `应注入，实际 ${outcome.status}`);
  assert.equal(h.speechToText.resolved.length, 1, '应调一次 resolve');
  assert.equal(h.speechToText.resolved[0].language, 'zh', 'language 必须原样透传');
  assert.ok(Buffer.isBuffer(h.speechToText.resolved[0].audio), 'audio 必须是 Buffer（内核落盘的 WAV）');
  assert.equal(h.speechToText.transcribed.length, 1, '应调一次 transcribe');
  assert.equal(h.agents.steered.length, 1, '应 steer 一条消息');
  assertUserMessageShape(h.agents.steered[0].message);
  assert.equal(h.agents.steered[0].message.content[0].text, '帮我把构建脚本跑一遍');
  assert.equal(h.agents.steered[0].id, 's1', '注入给解析出来的目标会话');
  assert.equal(h.agents.followed.length, 0, '默认走 steer，不该调 followup');
  assert.deepEqual(h.removed, ['/tmp/asr/utt-000001.wav'], '识别完必须删掉临时录音');
});

await test('全双工防自注入①：识别结果与最近播报高度重合 → 不注入（真机踩过的回声）', async () => {
  // 真机时间线：07:03:47 助手播报「明白，我先确认重启后的当前状态，再顺着问题往下排查。」
  //            07:03:50 麦克风把它收回去，识别出同一句，被当成"用户说的话"注入 → 重复
  const spoken = '明白，我先确认重启后的当前状态，再顺着问题往下排查';
  const h = duplexHarness({
    text: spoken,
    recentSpeech: () => [{ text: spoken, at: Date.now() }],
  });
  const outcome = await h.duplex.handle({ path: '/tmp/asr/utt-000001.wav', id: 'utt-000001.wav', seconds: 3.2 });
  assert.equal(outcome.status, 'echo-text', `应判定为回声，实际 ${outcome.status}`);
  assert.equal(h.agents.steered.length, 0, '绝不能把自己念的内容注入会话');
  assert.equal(h.duplex.stats().skipped, 1, '应计入 skipped');
});

await test('全双工防自注入②：用户真实的话不受影响（相似度不足则照常注入）', async () => {
  const h = duplexHarness({
    text: '把那个构建脚本再跑一遍看看',
    recentSpeech: () => [{ text: '明白，我先确认重启后的当前状态，再顺着问题往下排查', at: Date.now() }],
  });
  const outcome = await h.duplex.handle({ path: '/tmp/asr/utt-000002.wav', id: 'utt-000002.wav', seconds: 2.0 });
  assert.equal(outcome.status, 'injected', `不该误杀，实际 ${outcome.status}`);
  assert.equal(h.agents.steered.length, 1);
});

await test('全双工防自注入③：识别结果与较早的播报重合 → 不拦（避免误杀用户复述）', async () => {
  const spoken = '这一轮结束了';
  const h = duplexHarness({
    text: spoken,
    // 40 秒前念过的：超出 20 秒比对窗口，应放行
    recentSpeech: () => [{ text: spoken, at: Date.now() - 40000 }],
  });
  const outcome = await h.duplex.handle({ path: '/tmp/asr/utt-000003.wav', id: 'utt-000003.wav', seconds: 1.2 });
  assert.equal(outcome.status, 'injected', `超窗口应放行，实际 ${outcome.status}`);
});

await test('全双工防自注入④：起于播放冷却窗内的句子直接丢弃（afterPlayback 标记）', async () => {
  const h = duplexHarness({ text: '随便什么内容' });
  const outcome = await h.duplex.handle({
    path: '/tmp/asr/utt-000004.wav', id: 'utt-000004.wav', seconds: 2.5, afterPlayback: true,
  });
  assert.equal(outcome.status, 'echo-tail', `应判为回声尾巴，实际 ${outcome.status}`);
  assert.equal(h.agents.steered.length, 0, '不该注入');
});

await test('全双工防自注入⑤：duplexEchoGuard=false 时关掉兜底（保留用户选择）', async () => {
  const spoken = '明白，我先确认重启后的当前状态';
  const h = duplexHarness({
    text: spoken,
    config: { duplexEchoGuard: false },
    recentSpeech: () => [{ text: spoken, at: Date.now() }],
  });
  const outcome = await h.duplex.handle({ path: '/tmp/asr/utt-000005.wav', id: 'utt-000005.wav', seconds: 2.0 });
  assert.equal(outcome.status, 'injected', `关掉兜底后应注入，实际 ${outcome.status}`);
});

await test('全双工②：同一句只注入一次（内核重发同一 id 不许注入两遍）', async () => {
  const h = duplexHarness();
  const event = { path: '/tmp/asr/utt-000007.wav', id: 'utt-000007.wav', seconds: 1.4 };
  const first = await h.duplex.handle(event);
  const second = await h.duplex.handle({ ...event });
  assert.equal(first.status, 'injected');
  assert.equal(second.status, 'duplicate', `第二次应判重复，实际 ${second.status}`);
  assert.equal(h.agents.steered.length, 1, `只许注入一次，实际 ${h.agents.steered.length}`);
  assert.equal(h.speechToText.transcribed.length, 1, '重复事件不该再识别一遍');
  assert.deepEqual(h.removed, ['/tmp/asr/utt-000007.wav'], '重复事件不得删第一份还在用的文件');
  assert.equal(h.duplex.stats().duplicates, 1);
});

await test('全双工③：识别失败只留痕，不抛错、不注入（绝不影响会话）', async () => {
  const h = duplexHarness({ fail: true });
  let outcome = null;
  await assert.doesNotReject(async () => {
    outcome = await h.duplex.handle({ path: '/tmp/asr/a.wav', id: 'a.wav' });
  });
  assert.equal(outcome.status, 'transcribe-failed');
  assert.equal(h.agents.steered.length, 0, '识别失败不许注入');
  assert.deepEqual(h.removed, ['/tmp/asr/a.wav'], '识别失败也要清掉临时录音');
  assert.equal(h.duplex.stats().failed, 1);
});

await test('全双工④：录音文件缺失（ENOENT）不抛错、不注入', async () => {
  const h = duplexHarness({ missingFile: true });
  const outcome = await h.duplex.handle({ path: '/tmp/asr/gone.wav', id: 'gone.wav' });
  assert.equal(outcome.status, 'read-failed');
  assert.equal(h.speechToText.transcribed.length, 0, '读不到文件就不该去识别');
  assert.equal(h.agents.steered.length, 0);
  assert.equal(h.duplex.stats().failed, 1);
});

await test('全双工⑤：识别文本为空 / 语言不在白名单 → 都不注入且不抛', async () => {
  const empty = duplexHarness({ text: '   ' });
  assert.equal((await empty.duplex.handle({ path: '/tmp/asr/e.wav', id: 'e.wav' })).status, 'empty-text');
  assert.equal(empty.agents.steered.length, 0, '空文本不许注入');

  // resolve 抛错（官方 resolve 对白名单外的语言就是抛）也要被接住
  const bad = duplexHarness({ config: { duplexLanguage: 'fr' } });
  const outcome = await bad.duplex.handle({ path: '/tmp/asr/f.wav', id: 'f.wav' });
  assert.equal(outcome.status, 'resolve-failed', `白名单外的语言应失败但不抛，实际 ${outcome.status}`);
  assert.equal(bad.agents.steered.length, 0);
});

await test('全双工⑥：speechToText 不可用 → 通路安全关闭（available=false，不抛）', async () => {
  const h = duplexHarness({ service: false });
  assert.equal(h.duplex.available, false);
  const outcome = await h.duplex.handle({ path: '/tmp/asr/x.wav', id: 'x.wav' });
  assert.equal(outcome.status, 'no-service');
  assert.equal(h.agents.steered.length, 0);
  assert.deepEqual(h.removed, ['/tmp/asr/x.wav'], '用不上的录音也要清掉，别堆在临时目录');
});

await test('全双工⑦：duplexInjectMode=followup 时走 followup，且 language 配置生效', async () => {
  const h = duplexHarness({ config: { duplexInjectMode: 'followup', duplexLanguage: 'en' } });
  const outcome = await h.duplex.handle({ path: '/tmp/asr/g.wav', id: 'g.wav' });
  assert.equal(outcome.status, 'injected');
  assert.equal(h.speechToText.resolved[0].language, 'en', 'language 应取配置值');
  assert.equal(h.agents.followed.length, 1, '应调 followup');
  assert.equal(h.agents.steered.length, 0, 'followup 模式下不该再 steer');
  assert.equal(outcome.mode, 'followup');
});

await test('全双工⑧：目录外的路径一律拒绝（不读、不认领、不删）', async () => {
  const h = duplexHarness({ utteranceDir: '/tmp/asr-own' });
  // ⚠️ 刻意用 /tmp 之外的路径（且不写真实家目录，避免隐私检查误报）。
  const outside = '/var/tmp/not-our-utterance/important.wav';
  const outcome = await h.duplex.handle({ path: outside, id: 'important.wav' });
  assert.equal(outcome.status, 'outside-dir');
  assert.equal(h.read.length, 0, '不该去读目录外的文件');
  assert.deepEqual(h.removed, [], '更不该删目录外的文件');
  assert.equal(h.agents.steered.length, 0);
});

console.log('\n── 6. 配置解析 ──');
await test('兼容 schemastery 访问器与普通值两种形状', () => {
  const accessor = { get: () => 42 };
  assert.equal(readField({ a: accessor }, 'a', 0), 42);
  assert.equal(readField({ a: 7 }, 'a', 0), 7);
  assert.equal(readField({}, 'a', 9), 9);
  assert.equal(readField({ a: { get: () => { throw new Error('boom'); } } }, 'a', 5), 5, '访问器抛错应回落默认值');
});

await test('数值字段被钳制到合法区间', () => {
  const config = resolveConfig({ volume: 999, maxChars: -5, stageToolCalls: -1, throttleMs: -100 });
  assert.equal(config.volume, 100);
  assert.equal(config.maxChars, 0);
  assert.equal(config.stageToolCalls, 0);
  assert.equal(config.throttleMs, 0);
});

await test('数组字段：缺省、非法值、清洗', () => {
  assert.deepEqual(resolveConfig({}).toolErrorIgnoreCodes, ['FS_NOT_OBSERVED', 'FS_STALE_VERSION']);
  assert.deepEqual(resolveConfig({ toolErrorIgnoreCodes: 'nope' }).toolErrorIgnoreCodes, ['FS_NOT_OBSERVED', 'FS_STALE_VERSION'], '非数组应回落默认');
  assert.deepEqual(resolveConfig({ toolErrorIgnoreCodes: ['A', '', 5, 'B'] }).toolErrorIgnoreCodes, ['A', 'B'], '应剔除非字符串与空串');
  assert.deepEqual(resolveConfig({ toolErrorIgnoreCodes: [] }).toolErrorIgnoreCodes, [], '空数组是合法选择（全部播报）');
  assert.equal(resolveConfig({}).toolErrorPriority, 'normal');
});

await test('路径字段展开 ~（包内默认值要跨机器可用）', () => {
  const home = os.homedir();
  assert.equal(expandHome('~/.dsh/x.log'), `${home}/.dsh/x.log`);
  assert.equal(expandHome('~'), home);
  assert.equal(expandHome('  ~/a  '), `${home}/a`, '应先去空白再展开');
  assert.equal(expandHome('/abs/path'), '/abs/path', '绝对路径原样');
  assert.equal(expandHome('rel/path'), 'rel/path', '相对路径保持相对（交由 engine 解析）');
  assert.equal(expandHome(undefined), '');
  // 经过 resolveConfig 后，三个路径字段都已展开
  const cfg = resolveConfig({ logFile: '~/x.log', engine: './engine/e.sh', cwd: '~/work' });
  assert.equal(cfg.logFile, `${home}/x.log`);
  assert.equal(cfg.cwd, `${home}/work`);
  assert.equal(cfg.engine, './engine/e.sh', './ 开头必须保留，留给 engine 按包根解析');
});

await test('barge-in 配置：默认值 + 钳制 + 路径展开（不改则与 v1.6.0 一致）', () => {
  const cfg = resolveConfig({});
  assert.equal(cfg.mode, 'off', 'mode 缺省是「原始」档：不启用双工，行为等价于没有双工');
  assert.equal(cfg.audioCorePath, './engine/audio-core', '默认指向包内内核');
  assert.equal(cfg.bargeInEnabled, true);
  assert.equal(cfg.bargeInOverDb, 9);
  assert.equal(cfg.bargeInOverDbPlaying, 14, '播放期用更严门限（防自打断）');
  assert.equal(cfg.bargeInReleaseMs, 600);

  const clamped = resolveConfig({ bargeInOverDb: -3, bargeInReleaseMs: -100, bargeInEnabled: false });
  assert.equal(clamped.bargeInOverDb, 0, '负值钳到 0');
  assert.equal(clamped.bargeInReleaseMs, 0, '负值钳到 0');
  assert.equal(clamped.bargeInEnabled, false, '显式关掉要保留');
  assert.equal(resolveConfig({ audioCorePath: '~/core' }).audioCorePath, `${os.homedir()}/core`, '路径字段要展开 ~');
});

await test('全双工配置：默认值 + 归一化（非法值一律回落默认）', () => {
  const cfg = resolveConfig({});
  assert.equal(cfg.duplexEnabled, true, '全双工默认开（只对 full 档生效）');
  assert.equal(cfg.duplexLanguage, 'zh');
  assert.equal(cfg.duplexInjectMode, 'steer', '用户已拍板：默认 steer（插进当前回合）');

  assert.equal(resolveConfig({ duplexLanguage: '   ' }).duplexLanguage, 'zh', '空白回落 zh');
  assert.equal(resolveConfig({ duplexLanguage: 'en' }).duplexLanguage, 'en');
  assert.equal(resolveConfig({ duplexInjectMode: 'followup' }).duplexInjectMode, 'followup');
  assert.equal(resolveConfig({ duplexInjectMode: 'nope' }).duplexInjectMode, 'steer', '非法值回落 steer');
  assert.equal(resolveConfig({ duplexEnabled: false }).duplexEnabled, false, '显式关掉要保留');
});

await test('档位看门狗节拍：默认 1.5s、0=关闭、非 0 有下限（防热循环）', () => {
  assert.equal(resolveConfig({}).modeWatchMs, 1500, '默认 1.5 秒一拍');
  assert.equal(resolveConfig({ modeWatchMs: 0 }).modeWatchMs, 0, '0 = 关闭看门狗');
  assert.equal(resolveConfig({ modeWatchMs: -5 }).modeWatchMs, 0, '负值按关闭处理');
  assert.equal(resolveConfig({ modeWatchMs: 3 }).modeWatchMs, 50, '非 0 时钳到 50ms 下限');
  assert.equal(resolveConfig({ modeWatchMs: 800 }).modeWatchMs, 800, '正常值原样');
});

await test('engine 路径解析：./ 相对包根、其余原样', () => {
  const resolved = resolveEnginePath('./engine/minimax-speak.sh');
  assert.ok(resolved.startsWith('/'), `应解析成绝对路径，实际 ${resolved}`);
  assert.ok(resolved.endsWith('/engine/minimax-speak.sh'), `应指向包内 engine/，实际 ${resolved}`);
  assert.ok(!resolved.includes('/./'), '不应残留 ./');
  const pkgRoot = resolved.replace(/\/engine\/minimax-speak\.sh$/, '');
  assert.equal(resolveEnginePath('../x.sh'), path.resolve(pkgRoot, '../x.sh'), '../ 也应相对包根');
  assert.equal(resolveEnginePath('/usr/bin/say'), '/usr/bin/say', '绝对路径原样');
  assert.equal(resolveEnginePath('say'), 'say', '裸命令名原样，交给宿主按 PATH 解析');
  assert.equal(resolveEnginePath(''), '');
  assert.equal(resolveEnginePath('   '), '');
  assert.equal(resolveEnginePath(undefined), '', '未配置时不该抛错');
});

console.log('\n── 7. 插件端到端（假宿主）──');

const { apply } = await import('../lib/index.js');

function baseConfig(overrides = {}) {
  return { throttleMs: 0, minGapMs: 0, ...overrides };
}

await test('完整一轮：事件流 → LLM 摘要 → 播报', async () => {
  const subprocess = fakeSubprocess();
  const llm = fakeLlm({ text: '已经把登录的 bug 修好了，测试也过了。' });
  const ctx = fakeCtx({ subprocess, llm });
  apply(ctx, baseConfig());

  const session = fakeSession();
  const feed = (event) => ctx.emit('session/event', session, event);
  feed({ type: 'user/message', data: { content: [{ type: 'text', text: '修一下登录 bug' }] } });
  feed({ type: 'turn/start', data: { turn: 1 } });
  feed({ type: 'tool/call', data: { name: 'read', arguments: '{"file_path":"auth.js"}' } });
  feed({ type: 'tool/result', data: { message: { isError: false } } });
  feed({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });

  await tick(80);
  const spoken = subprocess.calls.map((call) => call.argv.at(-1));
  assert.equal(spoken.length, 1, `应播报一次，实际 ${spoken.length}：${JSON.stringify(spoken)}`);
  assert.equal(spoken[0], '已经把登录的 bug 修好了，测试也过了。');
  assert.equal(llm.seen.length, 1, '应只调一次摘要');
  assert.equal(llm.seen[0].provider, 'deepseek-official');
  assert.equal(llm.seen[0].model, 'deepseek-chat');
  ctx.disposeAll();
});

await test('LLM 失败时降级为规则摘要，而不是沉默', async () => {
  const subprocess = fakeSubprocess();
  const llm = fakeLlm({ fail: true });
  const ctx = fakeCtx({ subprocess, llm });
  apply(ctx, baseConfig());

  const session = fakeSession();
  const feed = (event) => ctx.emit('session/event', session, event);
  feed({ type: 'turn/start', data: { turn: 1 } });
  feed({ type: 'tool/call', data: { name: 'bash' } });
  feed({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });

  await tick(80);
  const spoken = subprocess.calls.map((call) => call.argv.at(-1));
  assert.equal(spoken.length, 1, `降级后仍应播报：${JSON.stringify(spoken)}`);
  assert.ok(spoken[0].includes('1'), `规则摘要应带步数：${spoken[0]}`);
  ctx.disposeAll();
});

await test('LLM 抛异常时同样降级且不影响会话', async () => {
  const subprocess = fakeSubprocess();
  const llm = fakeLlm({ throwAt: 'call' });
  const ctx = fakeCtx({ subprocess, llm });
  apply(ctx, baseConfig());

  const session = fakeSession();
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  ctx.emit('session/event', session, { type: 'tool/call', data: { name: 'bash' } });
  assert.doesNotThrow(() => {
    ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  });
  await tick(80);
  assert.equal(subprocess.calls.length, 1, '应仍然播报');
  ctx.disposeAll();
});

await test('没有 llm 服务时直接走规则摘要', async () => {
  const subprocess = fakeSubprocess();
  const ctx = fakeCtx({ subprocess, llm: undefined, defaultSelection: { provider: 'p', model: 'm' } });
  apply(ctx, baseConfig());

  const session = fakeSession();
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  ctx.emit('session/event', session, { type: 'tool/call', data: { name: 'bash' } });
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await tick(80);
  assert.equal(subprocess.calls.length, 1);
  ctx.disposeAll();
});

await test('子代理会话默认不播报', async () => {
  const subprocess = fakeSubprocess();
  const ctx = fakeCtx({ subprocess, llm: fakeLlm() });
  apply(ctx, baseConfig());

  const sub = fakeSession('sub1', { origin: 'subagent' });
  ctx.emit('session/event', sub, { type: 'tool/call', data: { name: 'bash' } });
  ctx.emit('session/event', sub, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await tick(60);
  assert.equal(subprocess.calls.length, 0, '子代理不该触发播报');
  ctx.disposeAll();
});

await test('includeSubagents=true 时子代理也会播报', async () => {
  const subprocess = fakeSubprocess();
  const ctx = fakeCtx({ subprocess, llm: fakeLlm() });
  apply(ctx, baseConfig({ includeSubagents: true }));

  const sub = fakeSession('sub1', { origin: 'subagent' });
  ctx.emit('session/event', sub, { type: 'tool/call', data: { name: 'bash' } });
  ctx.emit('session/event', sub, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await tick(60);
  assert.equal(subprocess.calls.length, 1);
  ctx.disposeAll();
});

await test('minGapMs 抑制连续播报', async () => {
  const subprocess = fakeSubprocess();
  const ctx = fakeCtx({ subprocess, llm: fakeLlm() });
  apply(ctx, { throttleMs: 0, minGapMs: 60000 });

  const session = fakeSession();
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  ctx.emit('session/event', session, { type: 'tool/call', data: { name: 'bash' } });
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await tick(60);
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 2 } });
  ctx.emit('session/event', session, { type: 'tool/call', data: { name: 'bash' } });
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } });
  await tick(60);
  assert.equal(subprocess.calls.length, 1, `最小间隔内不该播第二次：${subprocess.calls.length}`);
  ctx.disposeAll();
});

await test('approval 打断 throttleMs 等待，立刻播报', async () => {
  const subprocess = fakeSubprocess();
  const ctx = fakeCtx({ subprocess, llm: fakeLlm({ text: '需要你批准写文件。' }) });
  apply(ctx, { throttleMs: 60000, minGapMs: 0 });

  const session = fakeSession();
  ctx.emit('session/event', session, { type: 'approval/asked', data: { toolName: 'write', reason: '要写系统文件' } });
  await tick(60);
  const spoken = subprocess.calls.map((call) => call.argv.at(-1));
  assert.equal(spoken.length, 1, `审批不该被防抖挡住：${JSON.stringify(spoken)}`);
  ctx.disposeAll();
});

await test('enabled=false 时完全不注册监听', async () => {
  const subprocess = fakeSubprocess();
  const ctx = fakeCtx({ subprocess, llm: fakeLlm() });
  apply(ctx, { enabled: false });
  assert.equal(ctx.handlers.size, 0, '不该注册任何事件监听');
  ctx.disposeAll();
});

// ⚠️ 这条守着一个设计缺陷：早期版本把 `mode: 'off'` 当成"关闭"、与 `enabled: false` 混为一谈，
//    于是用户想回到"照旧播报"时只能去翻总开关。四档语义定下后：
//    `off` = 原始档（照旧播报，只是不开双工）；`mute` = 真正停用。
await test("mode='off'（原始档）仍然照旧播报，只是不启用双工", async () => {
  const subprocess = fakeSubprocess();
  const ctx = fakeCtx({ subprocess, llm: fakeLlm({ text: '原始档也要念这一句。' }) });
  apply(ctx, baseConfig({ mode: 'off' }));
  assert.ok(ctx.handlers.size > 0, '原始档必须注册监听（否则就是不播报了）');

  const session = fakeSession();
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  ctx.emit('session/event', session, { type: 'user/message', data: { text: '随便干点活' } });
  ctx.emit('session/event', session, { type: 'tool/call', data: { name: 'bash', input: {} } });
  ctx.emit('session/event', session, { type: 'tool/result', data: {} });
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1 } });
  await tick(80);

  assert.ok(subprocess.calls.length > 0, '原始档必须真的发声（走老路径：wrapper 自播）');
  assert.equal(subprocess.coreCalls.length, 0, '原始档**不得**启用音频内核（不碰麦克风）');
  ctx.disposeAll();
});

await test("mode='mute' 才是真正停用", async () => {
  const subprocess = fakeSubprocess();
  const ctx = fakeCtx({ subprocess, llm: fakeLlm() });
  apply(ctx, { mode: 'mute' });
  assert.equal(ctx.handlers.size, 0, 'mute 档不该注册任何事件监听');
  ctx.disposeAll();
});

await test('卸载后不再播报，且正在朗读的进程被终止', async () => {
  const subprocess = fakeSubprocess({ hold: 500 });
  const ctx = fakeCtx({ subprocess, llm: fakeLlm() });
  apply(ctx, baseConfig());

  const session = fakeSession();
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  ctx.emit('session/event', session, { type: 'tool/call', data: { name: 'bash' } });
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await tick(40);
  assert.equal(subprocess.calls.length, 1);

  ctx.disposeAll();
  const before = subprocess.calls.length;
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 2 } });
  ctx.emit('session/event', session, { type: 'tool/call', data: { name: 'bash' } });
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } });
  await tick(80);
  assert.equal(subprocess.calls.length, before, '卸载后不该再启动朗读进程');
});

// ── 开工反馈 ─────────────────────────────────────────────
// ⚠️ 事件顺序必须照抄现实：实测 turn/start(seq 5) 早于 user/message(seq 9)。
//    第一版测试把顺序写反了，导致真实环境里 0/248 触发而测试却全绿。
const KCFG = { throttleMs: 0, minGapMs: 0, announceKickoff: true, kickoffThrottleMs: 0, kickoffMinTaskChars: 4, silenceHeartbeatMs: 0 };
const um = (text, kind = 'user') => ({ type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind } } });

await test('开工反馈：真实顺序（turn/start 先于 user/message）也能触发', async () => {
  const subprocess = fakeSubprocess();
  const llm = fakeLlm({ text: '收到，我先把触发机制理一遍，再改心跳。' });
  const ctx = fakeCtx({ subprocess, llm });
  apply(ctx, KCFG);
  const session = fakeSession();
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });   // ← 先
  ctx.emit('session/event', session, um('帮我把播报机制改得更拟人'));                 // ← 后
  await tick(90);
  const spoken = subprocess.calls.map((c) => c.argv.at(-1));
  assert.equal(spoken.length, 1, `应播一次开工反馈：${JSON.stringify(spoken)}`);
  assert.equal(spoken[0], '收到，我先把触发机制理一遍，再改心跳。');
  assert.ok(llm.seen[0].system.includes('刚交代'), '应使用开工专用人设');
  ctx.disposeAll();
});

await test('系统注入不算用户任务：不会触发开工反馈，也不会污染 lastUserTask', async () => {
  const subprocess = fakeSubprocess();
  const llm = fakeLlm({ text: '收到。' });
  const ctx = fakeCtx({ subprocess, llm });
  apply(ctx, { ...KCFG, announceTurnEnd: true, turnEndMinToolCalls: 0 });
  const session = fakeSession();
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  // 真实注入：31KB 的 AGENTS.md、29KB 技能目录
  ctx.emit('session/event', session, um('<system-reminder>\nThe following workspace instructions…'.padEnd(31437, 'x'), 'agent-instructions'));
  ctx.emit('session/event', session, um('<system-reminder>\nA skill is a reusable set…'.padEnd(29832, 'y'), 'skill-catalog'));
  ctx.emit('session/event', session, um('Current runtime context. This snapshot supersedes…', 'runtime-context'));
  await tick(90);
  assert.equal(subprocess.calls.length, 0, '系统注入不该触发开工反馈');
  // 再跑一轮真实任务，摘要里出现的必须是真任务而非注入
  const session2 = fakeSession();
  ctx.emit('session/event', session2, um('帮我核对一下这份清单'));
  ctx.emit('session/event', session2, { type: 'turn/start', data: { turn: 1 } });
  ctx.emit('session/event', session2, { type: 'tool/call', data: { name: 'bash' } });
  ctx.emit('session/event', session2, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await tick(120);
  const last = llm.seen.at(-1);
  const prompt = JSON.stringify(last.messages ?? []);
  assert.ok(prompt.includes('帮我核对一下这份清单'), `任务应是真用户输入：${prompt.slice(0, 200)}`);
  assert.ok(!prompt.includes('system-reminder'), '摘要里不该出现系统注入');
  ctx.disposeAll();
});

await test('收尾消息：末尾的提问必须进 prompt（只留前 160 字会吃掉 91% 的待决信号）', async () => {
  const subprocess = fakeSubprocess();
  const llm = fakeLlm({ text: '这一轮做完了。' });
  const ctx = fakeCtx({ subprocess, llm });
  apply(ctx, { ...KCFG, announceTurnEnd: true, turnEndMinToolCalls: 0 });
  const session = fakeSession();
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  // 实测：收尾消息中位 1615 字，结论在前、提问在最后
  const long = '结论先行：两个 bug 都已修完并验证通过。'.padEnd(900, '中段是过程描述。')
    + '最后，要不要我顺手做个余额预警？';
  ctx.emit('session/event', session, {
    type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'text', text: long }] } },
  });
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await tick(120);
  const prompt = JSON.stringify(llm.seen.at(-1).messages ?? []);
  assert.ok(prompt.includes('要不要我顺手做个余额预警'),
    `末尾提问必须保留在 prompt 里：${prompt.slice(0, 260)}`);
  ctx.disposeAll();
});

await test('开工反馈：同一轮内用户中途插话不重复播', async () => {
  const subprocess = fakeSubprocess();
  const ctx = fakeCtx({ subprocess, llm: fakeLlm({ text: '收到。' }) });
  apply(ctx, KCFG);
  const session = fakeSession();
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  ctx.emit('session/event', session, um('帮我把播报机制改一下'));
  await tick(80);
  const n1 = subprocess.calls.length;
  ctx.emit('session/event', session, um('对了，顺便把音色也换掉'));   // steering
  await tick(80);
  assert.equal(subprocess.calls.length, n1, '同一轮内的插话不该再播一次开工反馈');
  ctx.disposeAll();
});

await test('开工反馈：任务太短（"继续"）不播', async () => {
  const subprocess = fakeSubprocess();
  const ctx = fakeCtx({ subprocess, llm: fakeLlm() });
  apply(ctx, KCFG);
  const session = fakeSession();
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  ctx.emit('session/event', session, um('继续'));
  await tick(90);
  assert.equal(subprocess.calls.length, 0, '两个字的消息不该触发开工反馈');
  ctx.disposeAll();
});

await test('开工反馈用自己的短节流窗口（不被默认长防抖拖累）', async () => {
  const subprocess = fakeSubprocess();
  const ctx = fakeCtx({ subprocess, llm: fakeLlm({ text: '收到。' }) });
  apply(ctx, { ...KCFG, throttleMs: 60000, kickoffThrottleMs: 0 });
  const session = fakeSession();
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  ctx.emit('session/event', session, um('帮我改一下播报的触发机制'));
  await tick(90);
  assert.equal(subprocess.calls.length, 1, '开工反馈不该被 throttleMs=60s 挡住');
  ctx.disposeAll();
});

await test('turn/end 后重置：下一轮无新用户消息时不重念旧任务', async () => {
  const subprocess = fakeSubprocess();
  const ctx = fakeCtx({ subprocess, llm: fakeLlm({ text: '收到。' }) });
  apply(ctx, KCFG);
  const session = fakeSession();
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  ctx.emit('session/event', session, um('把播报机制改一下'));
  ctx.emit('session/event', session, { type: 'tool/call', data: { name: 'bash' } });
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await tick(90);
  const after1 = subprocess.calls.length;
  // 自动续跑 / goal 轮：只有 turn/start，没有新用户消息
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 2 } });
  await tick(90);
  assert.equal(subprocess.calls.length, after1, '没有新用户消息的轮次不该重复念旧任务');
  ctx.disposeAll();
});

// ── turn-end 不能被中途播报吃掉 ────────────────────────────
// 实测时序（2026-10-01 04:48）：turn/start → 21 次工具调用 → 心跳播报（drain 清零计数）
// → 3 秒后 turn/end → 判定"没干活"→ 整轮收尾播报被静默丢弃。
const TECFG = { throttleMs: 0, minGapMs: 0, announceKickoff: false, silenceHeartbeatMs: 0,
                announceTurnEnd: true, turnEndMinToolCalls: 1, stageToolCalls: 2 };

await test('中途播报清零计数后，turn-end 仍必须播（该轮干过活）', async () => {
  const subprocess = fakeSubprocess();
  const ctx = fakeCtx({ subprocess, llm: fakeLlm({ text: '这一轮做完了。' }) });
  apply(ctx, TECFG);
  const session = fakeSession();
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  // 2 次工具调用 → 触发 tool-milestone → 播报 → drain 把 toolCallsSinceAnnounce 清零
  ctx.emit('session/event', session, { type: 'tool/call', data: { name: 'bash' } });
  ctx.emit('session/event', session, { type: 'tool/call', data: { name: 'bash' } });
  await tick(150);
  const afterMilestone = subprocess.calls.length;
  assert.ok(afterMilestone >= 1, `里程碑应先播一次：${afterMilestone}`);
  // 轮次结束，此后没有任何新工具调用 —— 旧逻辑在这里误判为"没干活"
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await tick(250);
  assert.ok(subprocess.calls.length > afterMilestone,
    'turn-end 必须播：判断依据应是「这一轮有没有干活」，不是「距上次播报的活动量」');
  ctx.disposeAll();
});

await test('零工具调用的聊天轮次：不念摘要，但结束信号必须给（只播收束语）', async () => {
  const subprocess = fakeSubprocess();
  const llm = fakeLlm();
  const ctx = fakeCtx({ subprocess, llm });
  apply(ctx, TECFG);
  const session = fakeSession();
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  ctx.emit('session/event', session, {
    type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的，我明白了。' }] } },
  });
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await tick(250);
  const spoken = subprocess.calls.map((c) => c.argv.at(-1));
  assert.deepEqual(spoken, ['这一轮结束了。'], `聊天轮次只播收束语，实际：${JSON.stringify(spoken)}`);
  assert.equal(llm.seen.length, 0, '没有可汇报的操作，就不该为此调一次模型');
  ctx.disposeAll();
});

await test('announceTurnEndOnChat=false 时，聊天轮次回归静默（旧行为可恢复）', async () => {
  const subprocess = fakeSubprocess();
  const ctx = fakeCtx({ subprocess, llm: fakeLlm() });
  apply(ctx, { ...TECFG, announceTurnEndOnChat: false });
  const session = fakeSession();
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  ctx.emit('session/event', session, {
    type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的，我明白了。' }] } },
  });
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await tick(250);
  assert.equal(subprocess.calls.length, 0, '关掉开关后应完全静默');
  ctx.disposeAll();
});

// ── turn-end 收束语：确定性的"这一轮结束了" ──────────────────────
// 2026-10-01 用户反馈：「任务全部完成之后，我可能听不出来这是一个明确的会话结束信号。」
// 审计证据：30 条 turn-end 播报里只有 4 条带收尾措辞、且措辞各不相同（这轮任务完成 / 这轮结束了 /
// 这一轮做完了），而同期 156 条**中途**进展播报里也有 10 条含同类词汇 —— 两边词汇重叠，
// 耳朵没有任何可依赖的判别特征。修法：收束语由代码写死（closerFor），在摘要之外拼到**句首**。

await test('收束语：三种结束原因各有确定文案，未知原因回退到"正常结束"', () => {
  assert.equal(closerFor('completed'), '这一轮结束了。');
  assert.equal(closerFor('error'), '这一轮报错中断了。');
  assert.equal(closerFor('aborted'), '这一轮被中断了。');
  assert.equal(closerFor('max-steps'), '这一轮结束了。', '未知 kind 不该让播报变成 undefined');
  assert.equal(closerFor(undefined), '这一轮结束了。');
});

await test('收束语：turn-end 以收束语开头，并区分完成 / 报错 / 中断', async () => {
  for (const [kind, closer] of [['completed', '这一轮结束了。'], ['error', '这一轮报错中断了。'], ['aborted', '这一轮被中断了。']]) {
    const subprocess = fakeSubprocess();
    const ctx = fakeCtx({ subprocess, llm: fakeLlm({ text: '修好了两处配置。' }) });
    apply(ctx, TECFG);
    const session = fakeSession();
    ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
    ctx.emit('session/event', session, { type: 'tool/call', data: { callId: 'c1', name: 'bash' } });
    ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind } } });
    await tick(250);
    const spoken = subprocess.calls.map((c) => c.argv.at(-1)).join('');
    assert.ok(spoken.startsWith(closer), `${kind} 应以「${closer}」开头，实际：${spoken}`);
    assert.ok(spoken.includes('修好了两处配置'), `${kind} 的摘要应保留在后面：${spoken}`);
    ctx.disposeAll();
  }
});

await test('收束语：只有 turn-end 带，中途里程碑不带（否则信号又失去区分度）', async () => {
  const subprocess = fakeSubprocess();
  const ctx = fakeCtx({ subprocess, llm: fakeLlm({ text: '正在改配置。' }) });
  apply(ctx, TECFG);
  const session = fakeSession();
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  ctx.emit('session/event', session, { type: 'tool/call', data: { callId: 'a', name: 'bash' } });
  ctx.emit('session/event', session, { type: 'tool/call', data: { callId: 'b', name: 'bash' } });
  await tick(250);
  const spoken = subprocess.calls.map((c) => c.argv.at(-1)).join('');
  assert.ok(spoken.includes('正在改配置'), `中途里程碑应播摘要：${spoken}`);
  assert.ok(!spoken.includes('这一轮结束了'), `中途播报不许带收束语：${spoken}`);
  ctx.disposeAll();
});

await test('收束语结构性安全：摘要被 maxChars 截断后，句首收束语仍完整', async () => {
  const subprocess = fakeSubprocess();
  const ctx = fakeCtx({ subprocess, llm: fakeLlm({ text: '第一句很长很长。第二句也很长。第三句收尾。' }) });
  apply(ctx, { ...TECFG, maxChars: 12 });
  const session = fakeSession();
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  ctx.emit('session/event', session, { type: 'tool/call', data: { callId: 'c1', name: 'bash' } });
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await tick(250);
  const spoken = subprocess.calls.map((c) => c.argv.at(-1)).join('');
  assert.ok(spoken.startsWith('这一轮结束了。'), `收束语必须在最前且完整：${spoken}`);
  assert.ok(
    spoken.length <= '这一轮结束了。'.length + 12,
    `摘要应受 maxChars 限制，收束语不该把总量撑破：${spoken.length}`,
  );
  ctx.disposeAll();
});

await test('composeAnnouncement：收束语在前；摘要为空时收束语仍然出声', () => {
  assert.equal(composeAnnouncement('这一轮结束了。', '做了三件事。'), '这一轮结束了。做了三件事。');
  assert.equal(composeAnnouncement('这一轮结束了。', ''), '这一轮结束了。', '摘要失败不能吞掉结束信号');
  assert.equal(composeAnnouncement('', '做了三件事。'), '做了三件事。', '非 turn-end 边界不带收束语');
  assert.equal(composeAnnouncement('', ''), '', '两边都空才允许 dropped');
  assert.equal(composeAnnouncement(undefined, undefined), '');
});

// ── 回归：规则兜底不许断言"没卡住"（v1.5.1）───────────────────────────
// 人设早在 v1.4.0 就禁了这类无法证实的断言，但**规则兜底文案漏改**（用户 2026-10-01 指出）。

await test('规则兜底：任何边界的文案都不许断言"没卡住 / 一切正常 / 快好了"', () => {
  const snapshots = [
    { lines: [], toolCalls: 0, turnToolCalls: 0 },
    { lines: ['工具 bash'], toolCalls: 5, turnToolCalls: 5 },
    { lines: ['工具报错（E_TOOL）'], toolCalls: 1, turnToolCalls: 1 },
    { lines: ['待办 3/5 完成'], toolCalls: 2, turnToolCalls: 2 },
  ];
  const reasons = ['progress-heartbeat', 'turn-end', 'tool-milestone', 'tool-error',
                   'approval', 'user-question', 'kickoff', 'goal-change'];
  for (const snap of snapshots) {
    for (const reason of reasons) {
      const text = ruleSummary(snap, reason);
      for (const banned of ['没有卡住', '没卡住', '一切正常', '快好了']) {
        assert.ok(
          !text.includes(banned),
          `${reason} 的规则兜底出现了无法证实的断言「${banned}」：${text}`,
        );
      }
    }
  }
  // 正面断言：心跳兜底要给出可核对的事实（走了几步）
  assert.ok(ruleSummary({ lines: [], toolCalls: 7, turnToolCalls: 7 }, 'progress-heartbeat').includes('7'));
});

// ── 回归：收束语被连说两遍（2026-10-01 06:53 用户实听）───────────────────
// 现场：06:52:49 一次心跳播报 drain() 把 toolCallsSinceAnnounce 清零 →
// 06:53:06 turn-end 时快照里 toolCalls=0 → 规则兜底吐出「这一轮结束了。」，
// 而它恰好等于 v1.3.0 的确定性收束语 → 拼成「这一轮结束了。这一轮结束了。」。

await test('composeAnnouncement：摘要自带收束语时不得重复拼接', () => {
  assert.equal(composeAnnouncement('这一轮结束了。', '这一轮结束了。'), '这一轮结束了。');
  assert.equal(
    composeAnnouncement('这一轮结束了。', '这一轮结束了。我改了三个文件。'),
    '这一轮结束了。我改了三个文件。',
    '模型自己写了收束语时同理',
  );
  assert.equal(composeAnnouncement('这一轮结束了。', '我改了三个文件。'), '这一轮结束了。我改了三个文件。');
});

await test('规则兜底：turn-end 必须用轮次级计数，零步时不再吐出收束语本身', () => {
  assert.ok(
    ruleSummary({ lines: [], toolCalls: 0, turnToolCalls: 12 }, 'turn-end').includes('12'),
    '心跳清零快照后，仍必须报出整轮的真实步数',
  );
  assert.equal(
    ruleSummary({ lines: [], toolCalls: 0, turnToolCalls: 0 }, 'turn-end'),
    '这一轮没有具体操作。',
    '零步文案不得等于收束语，否则又会拼出重复',
  );
  assert.ok(ruleSummary({ lines: [], toolCalls: 5 }, 'turn-end').includes('5'), '旧快照（无 turnToolCalls）要向后兼容');
});

await test('回归（端到端）：心跳抽干计数后，收尾播报里收束语只许出现一次', async () => {
  const subprocess = fakeSubprocess();
  const ctx = fakeCtx({ subprocess, llm: fakeLlm({ fail: true }) }); // 强制走规则兜底
  apply(ctx, {
    throttleMs: 0, minGapMs: 0, announceKickoff: false, silenceHeartbeatMs: 200,
    announceTurnEnd: true, turnEndMinToolCalls: 1, stageToolCalls: 999,
  });
  const session = fakeSession();
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  ctx.emit('session/event', session, { type: 'tool/call', data: { callId: 'c1', name: 'bash' } });
  await tick(600); // ← 心跳播报发生，drain() 清零计数（复刻 06:52:49）
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await tick(400);
  const last = subprocess.calls.map((c) => c.argv.at(-1)).at(-1) ?? '';
  assert.ok(last.startsWith('这一轮结束了。'), `收尾仍要以收束语开头：${last}`);
  assert.equal(last.split('这一轮结束了').length - 1, 1, `收束语只许出现一次，实际：${last}`);
  assert.ok(last.includes('1 步操作'), `步数应取自轮次级计数：${last}`);
  ctx.disposeAll();
});

await test('审计留痕：announce 行第 4 字段标出来源（llm / rule / signal-only / fact）', async () => {
  const cases = [
    { name: 'llm', llm: fakeLlm({ text: '改了三个文件。' }), events: 'worked', reason: 'turn-end', want: 'llm' },
    { name: 'rule', llm: fakeLlm({ fail: true }), events: 'worked', reason: 'turn-end', want: 'rule' },
    { name: 'signal-only', llm: fakeLlm(), events: 'chat', reason: 'turn-end', want: 'signal-only' },
    // 事实型：等模型长生成期间的心跳，不调摘要模型
    { name: 'fact', llm: fakeLlm(), events: 'waiting', reason: 'progress-heartbeat', want: 'fact' },
  ];
  for (const item of cases) {
    const logFile = path.join(os.tmpdir(), `dspeak-src-${item.name}-${process.pid}-${Date.now()}.log`);
    try {
      const subprocess = fakeSubprocess();
      const ctx = fakeCtx({ subprocess, llm: item.llm });
      apply(ctx, {
        throttleMs: 0, minGapMs: 0, announceKickoff: false, logFile,
        // 等待态用例需要心跳活着；其余用例关掉心跳避免噪声
        silenceHeartbeatMs: item.events === 'waiting' ? 200 : 0,
      });
      const session = fakeSession();
      ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
      if (item.events === 'worked') {
        ctx.emit('session/event', session, { type: 'tool/call', data: { callId: 'c1', name: 'bash' } });
      }
      if (item.events === 'waiting') {
        ctx.emit('session/event', session, { type: 'step/start', data: { turn: 1, step: 1 } });
      } else {
        ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
      }
      await tick(500);
      const announces = fs.readFileSync(logFile, 'utf8').trim().split('\n')
        .map((line) => line.split('\t'))
        .filter((parts) => parts[1] === 'announce' && parts[2] === item.reason);
      assert.equal(announces.length, 1, `${item.name}：应有一条 ${item.reason} 播报`);
      assert.equal(announces[0][4], item.want, `${item.name}：来源字段错误（${announces[0].join(' | ')}）`);
      ctx.disposeAll();
    } finally {
      try { fs.unlinkSync(logFile); } catch { /* 忽略 */ }
    }
  }
});

// ── 通道契约：判定了就必须留下留痕 ────────────────────────
// 2026-10-01 排查「判定了却没播」时，4 条边界无法归因 —— 因为「合并」和「流水线失败」
// 都不写审计日志。现在约定：每个 boundary 最终必有 announce / dropped / coalesced / pipeline-error 之一。
await test('通道契约：每个判定过的边界都留下留痕（不留无法归因的死角）', async () => {
  const logFile = path.join(os.tmpdir(), `dspeak-contract-${process.pid}-${Date.now()}.log`);
  try {
    const subprocess = fakeSubprocess();
    const ctx = fakeCtx({ subprocess, llm: fakeLlm({ text: '播报内容。' }) });
    apply(ctx, {
      throttleMs: 150, minGapMs: 0, announceKickoff: false, silenceHeartbeatMs: 0,
      announceTurnEnd: true, turnEndMinToolCalls: 0, stageToolCalls: 2, logFile,
    });
    const session = fakeSession();
    ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
    // 4 次工具调用 → 撞出 2 个 milestone，第二个应落在第一个的防抖窗口内被合并
    for (let i = 0; i < 4; i++) ctx.emit('session/event', session, { type: 'tool/call', data: { name: 'bash' } });
    await tick(400);
    ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    await tick(400);

    const kinds = fs.readFileSync(logFile, 'utf8').trim().split('\n')
      .map((line) => line.split('\t')[1]).filter(Boolean);
    const boundaries = kinds.filter((k) => k === 'boundary').length;
    const closed = kinds.filter((k) => ['announce', 'dropped', 'coalesced', 'pipeline-error'].includes(k)).length;
    assert.ok(boundaries >= 2, `应判定出多个边界，实际 ${boundaries}`);
    assert.equal(closed, boundaries,
      `每个判定都要有归属：判定 ${boundaries}，留痕 ${closed}（${JSON.stringify(kinds)}）`);
    assert.ok(kinds.includes('coalesced'), `应记录到合并：${JSON.stringify(kinds)}`);
  } finally {
    try { fs.unlinkSync(logFile); } catch { /* 忽略 */ }
  }
});

// ── 静默心跳 ─────────────────────────────────────────────
const HCFG = { throttleMs: 0, minGapMs: 0, announceKickoff: false, announceTurnEnd: false,
               silenceHeartbeatMs: 300, stageToolCalls: 999 };

await test('静默心跳：本轮进行中 + 有活动 + 超时 → 报一次进展', async () => {
  const subprocess = fakeSubprocess();
  const llm = fakeLlm({ text: '还在改配置，已经到第二处了。' });
  const ctx = fakeCtx({ subprocess, llm });
  apply(ctx, HCFG);
  const session = fakeSession();
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  ctx.emit('session/event', session, { type: 'tool/call', data: { name: 'bash' } });
  await tick(800);                         // 300ms 阈值 + 200ms 轮询，留足余量
  const spoken = subprocess.calls.map((c) => c.argv.at(-1));
  assert.ok(spoken.length >= 1, `应播至少一次心跳：${JSON.stringify(spoken)}`);
  assert.ok(llm.seen[0].system.includes('看不到屏幕'), '应使用心跳专用人设');
  ctx.disposeAll();
});

await test('心跳健壮性：插件在某轮中途才挂载（没看到 turn/start）也能触发', async () => {
  const subprocess = fakeSubprocess();
  const ctx = fakeCtx({ subprocess, llm: fakeLlm({ text: '还在跑，本阶段走了几步。' }) });
  apply(ctx, HCFG);
  const session = fakeSession();
  // 刻意不发 turn/start —— 模拟插件在这一轮进行到一半时才加载
  ctx.emit('session/event', session, { type: 'tool/call', data: { name: 'bash' } });
  await tick(800);
  assert.ok(subprocess.calls.length >= 1, '中途挂载也应能心跳，否则重启后当轮永远静默');
  ctx.disposeAll();
});

await test('静默心跳守卫：没有活动不报（防"卡住了还硬说在干活"）', async () => {
  const subprocess = fakeSubprocess();
  const ctx = fakeCtx({ subprocess, llm: fakeLlm() });
  apply(ctx, HCFG);
  const session = fakeSession();
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  await tick(800);                         // 只有 turn/start，没有任何工具调用
  assert.equal(subprocess.calls.length, 0, '没有活动时绝不该播心跳');
  ctx.disposeAll();
});

// ── 回归：阻塞型工具调用期间的整段静默（2026-10-01 实测 187 秒）─────────────
// 实测现场：`bash {"command":"sleep 180; echo waited"}` 发出后，飞行期内零会话事件；
// 而前一次播报的 drain() 已把这条 tool/call 从缓冲抽走 → 守卫判"没活动" →
// 连续 10 个 tick 全部沉默（14:28:25→14:31:33）。下面是这对行为的成对回归。

await test('回归 187s 静默：长工具调用飞行期内，缓冲被 drain 抽干后仍必须报', async () => {
  const subprocess = fakeSubprocess();
  const llm = fakeLlm({ text: '还在等这一步跑完。' });
  const ctx = fakeCtx({ subprocess, llm });
  apply(ctx, HCFG);
  const session = fakeSession();
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  ctx.emit('session/event', session, {
    type: 'tool/call',
    data: { callId: 'call_sleep', name: 'bash', arguments: JSON.stringify({ command: 'sleep 180; echo waited' }) },
  });
  await tick(900);                          // 第一次心跳：来自缓冲里的那条 tool/call
  const afterFirst = subprocess.calls.length;
  const llmCallsAfterFirst = llm.seen.length;
  assert.ok(afterFirst >= 1, '第一次心跳应播');
  assert.equal(llmCallsAfterFirst, 1, '第一次有真实缓冲内容，应走摘要模型');
  // 关键：此后不再产生任何会话事件，完全复刻 sleep 飞行期
  await tick(900);
  assert.ok(
    subprocess.calls.length > afterFirst,
    `缓冲被抽干后，长调用的飞行期仍必须报心跳（旧代码在这里整段静默）：${subprocess.calls.length}`,
  );
  // v1.4.0：事实型心跳**不走摘要模型**，直接念那条如实描述（零编造 + 零延迟）
  const spoken = subprocess.calls.map((c) => c.argv.at(-1)).join('');
  assert.ok(spoken.includes('还在跑一条命令'), `应报状态短语：${spoken}`);
  assert.ok(!spoken.includes('sleep 180'), `绝不能念原始命令：${spoken}`);
  assert.ok(!spoken.includes('$('), `绝不能念原始参数：${spoken}`);
  assert.equal(llm.seen.length, llmCallsAfterFirst, '事实型心跳不该再调摘要模型');
  ctx.disposeAll();
});

await test('回归 187s 静默的边界：调用已结束且无新事件 → 必须恢复沉默', async () => {
  const subprocess = fakeSubprocess();
  const ctx = fakeCtx({ subprocess, llm: fakeLlm({ text: '还在跑。' }) });
  apply(ctx, HCFG);
  const session = fakeSession();
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  ctx.emit('session/event', session, { type: 'tool/call', data: { callId: 'c1', name: 'bash' } });
  ctx.emit('session/event', session, { type: 'tool/result', data: { toolCallId: 'c1', message: { source: { kind: 'tool', callId: 'c1' } } } });
  await tick(900);                          // 至多一次（缓冲里还留着那条 tool/call）
  const afterSettle = subprocess.calls.length;
  assert.ok(afterSettle <= 1, `调用结束后不该反复报：${afterSettle}`);
  await tick(900);
  assert.equal(
    subprocess.calls.length,
    afterSettle,
    '调用已结束、又无新事件 → 在飞计数必须归零，真卡住时要能沉默（不能为了填静默而永远报）',
  );
  ctx.disposeAll();
});

await test('在飞调用：按 callId 精确配对，乱序返回也不会错销', () => {
  const s = createSessionState('s');
  const cfg = { toolErrorIgnoreCodes: [] };
  noteEvent(s, { type: 'tool/call', data: { callId: 'a', name: 'bash' } }, cfg);
  noteEvent(s, { type: 'tool/call', data: { callId: 'b', name: 'web_fetch' } }, cfg);
  assert.deepEqual(s.inFlightCalls.map((c) => c.callId), ['a', 'b'], '两个调用都应在飞');
  noteEvent(s, { type: 'tool/result', data: { toolCallId: 'b', message: { source: { kind: 'tool', callId: 'b' } } } }, cfg);
  assert.deepEqual(s.inFlightCalls.map((c) => c.callId), ['a'], '先回来的 b 被销掉，a 仍在飞');
  noteEvent(s, { type: 'tool/result', data: { toolCallId: 'a' } }, cfg);
  assert.equal(s.inFlightCalls.length, 0, 'a 回来后应彻底归零');
  // 报错的结果同样要销账，否则计数只增不减 → 永远"有活在跑"
  noteEvent(s, { type: 'tool/call', data: { callId: 'c', name: 'bash' } }, cfg);
  noteEvent(s, { type: 'tool/result', data: { toolCallId: 'c', error: { code: 'E_TOOL' } } }, cfg);
  assert.equal(s.inFlightCalls.length, 0, '失败的结果也必须销掉在飞调用');
});

await test('在飞调用：turn/start 与 turn/end 都清空（中断留下的幽灵不许点亮心跳）', () => {
  const s = createSessionState('s');
  const cfg = { announceTurnEnd: true, turnEndMinToolCalls: 1 };
  noteEvent(s, { type: 'tool/call', data: { callId: 'a', name: 'bash' } }, cfg);
  assert.equal(s.inFlightCalls.length, 1, '调用应在飞');
  noteEvent(s, { type: 'turn/end', data: { reason: { kind: 'completed' } } }, cfg);
  assert.equal(s.inFlightCalls.length, 0, '轮次结束时在飞记录必须清空');
  noteEvent(s, { type: 'turn/start', data: { turn: 2 } }, cfg);
  noteEvent(s, { type: 'tool/call', data: { callId: 'b', name: 'bash' } }, cfg);
  noteEvent(s, { type: 'turn/start', data: { turn: 3 } }, cfg);
  assert.equal(s.inFlightCalls.length, 0, '新一轮开头也必须清空上一轮的残留');
});

await test('在飞调用：描述如实带出"在跑什么 + 等了多久 + 并发几个"', () => {
  const s = createSessionState('s');
  noteEvent(s, { type: 'tool/call', data: { callId: 'a', name: 'bash', arguments: JSON.stringify({ command: 'sleep 180; echo waited' }) } }, {});
  const line = pendingWorkLine(s, s.inFlightCalls[0].at + 178000);
  assert.equal(line, '还在跑一条命令，已经 2 分 58 秒', '状态短语 + 口语时长，不含原始参数');
  assert.ok(!line.includes('sleep 180'), `不得念原始命令：${line}`);
  assert.ok(!line.includes('bash'), `不得念英文工具名：${line}`);
  noteEvent(s, { type: 'tool/call', data: { callId: 'b', name: 'web_fetch' } }, {});
  assert.ok(pendingWorkLine(s, s.inFlightCalls[0].at).includes('另有 1 个操作在跑'), '并发时要说明还有别的在跑');
  assert.equal(pendingWorkLine(createSessionState('empty')), '', '没有在飞调用时返回空串');
});

// ── 长生成期间的播报（v1.4.0；节奏方案「丁」）────────────────────────────
// 官方定义：`step/start` = **一次模型调用 + 它请求的工具执行**。所以从 step/start 到
// assistant/message 之间主机确定处在一次模型调用中，而这整段**零会话事件**。
// 重放 33 个真实会话 / 393 段 >60s 静默：这类静默 **44 段 / 5,258 秒**
// （中位 92 秒、最长 323 秒）；而"完全没有任何状态可报"的真空段是 **0 段** —— 故不做时间兜底。

await test('formatDuration：时长要念成口语，不能报裸秒数', () => {
  assert.equal(formatDuration(30000), '30 秒');
  assert.equal(formatDuration(92000), '1 分 32 秒');
  assert.equal(formatDuration(120000), '2 分钟');
  assert.equal(formatDuration(323000), '5 分 23 秒');
  assert.equal(formatDuration(-5), '0 秒');
});

await test('等模型：step/start 之后进入等待态，话术只陈述事实', () => {
  const s = createSessionState('s');
  noteEvent(s, { type: 'turn/start', data: { turn: 1 } }, {});
  assert.equal(waitingLine(s), '', '还没开工时不该报"在等模型"');
  noteEvent(s, { type: 'step/start', data: { turn: 1, step: 1 } }, {});
  assert.equal(s.waitingKind, 'model');
  assert.equal(waitingLine(s, s.waitingSince + 130000), '还在等模型返回，已经 2 分 10 秒。');
});

await test('等模型：五类结束事件都要清位（否则会一直误报"还在等"）', () => {
  const cases = [
    ['assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: '好了。' }] } }],
    ['tool/call', { callId: 'c1', name: 'bash' }],
    ['step/end', { turn: 1, step: 1 }],
    ['assistant/attempt', { turn: 1, step: 1, stream: [] }],
    ['turn/end', { turn: 1, reason: { kind: 'completed' } }],
  ];
  for (const [type, data] of cases) {
    const s = createSessionState('s');
    noteEvent(s, { type: 'turn/start', data: { turn: 1 } }, {});
    noteEvent(s, { type: 'step/start', data: { turn: 1, step: 1 } }, {});
    assert.equal(s.waitingKind, 'model', `${type} 之前应处于等模型`);
    noteEvent(s, { type, data }, {});
    assert.equal(s.waitingKind, '', `${type} 之后必须清位`);
  }
});

await test('等模型：重试与上下文压缩也算"在干活"，各有如实文案', () => {
  const s = createSessionState('s');
  noteEvent(s, { type: 'turn/start', data: { turn: 1 } }, {});
  noteEvent(s, { type: 'compaction/start', data: {} }, {});
  assert.equal(s.waitingKind, 'compaction');
  assert.equal(waitingLine(s, s.waitingSince + 90000), '正在压缩上下文，已经 1 分 30 秒。');
  noteEvent(s, { type: 'compaction/end', data: {} }, {});
  assert.equal(s.waitingKind, '', '压缩结束要清位（其后紧跟的 step/start 会重新进入）');
  noteEvent(s, { type: 'llm/retry-started', data: {} }, {});
  assert.ok(waitingLine(s, s.waitingSince + 5000).startsWith('还在等模型返回'), '重试仍是等模型');
});

await test('等模型（端到端）：长生成期间必须出声，且不调摘要模型', async () => {
  const subprocess = fakeSubprocess();
  const llm = fakeLlm({ text: '这句不该被用到。' });
  const ctx = fakeCtx({ subprocess, llm });
  apply(ctx, HCFG);
  const session = fakeSession();
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  // 复刻真实时序：模型调用打开，然后长时间音信全无
  ctx.emit('session/event', session, { type: 'step/start', data: { turn: 1, step: 1 } });
  await tick(800);
  const spoken = subprocess.calls.map((c) => c.argv.at(-1)).join('');
  assert.ok(spoken.includes('还在等模型返回'), `长生成期间必须出声：${JSON.stringify(spoken)}`);
  assert.equal(llm.seen.length, 0, '事实型播报不调模型：零编造风险，也省一次往返');
  ctx.disposeAll();
});

await test('等模型续报下限（方案丁）：下限内不重复，越过下限仍会续报', async () => {
  const subprocess = fakeSubprocess();
  const ctx = fakeCtx({ subprocess, llm: fakeLlm() });
  apply(ctx, { ...HCFG, modelWaitMinGapMs: 900 }); // 默认 60000，这里用可测的小值
  const session = fakeSession();
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  ctx.emit('session/event', session, { type: 'step/start', data: { turn: 1, step: 1 } });
  await tick(700); // 首次：走共用的 silenceHeartbeatMs 阈值
  const first = subprocess.calls.length;
  assert.equal(first, 1, '应先报一次');
  await tick(200); // 距上次播报 500ms < 900ms 下限
  assert.equal(subprocess.calls.length, first, '下限内不得重复播报');
  await tick(1000); // 越过下限
  assert.ok(subprocess.calls.length > first, '越过下限后必须续报，否则又变回沉默');
  ctx.disposeAll();
});

// ── v1.5.0：多会话音色（方案 A，音色绑定会话）──────────────────────────
// 用户反馈：多会话并行时两边都播报，同一个音色分不清是哪一边。

await test('音色覆盖：不传覆盖时一切照旧（零回归）', () => {
  const { argv, env } = buildSpeechArgv('darwin', '/usr/bin/say', '你好', { voice: 'Lilian', rate: 0, volume: 100 });
  assert.deepEqual(argv, ['/usr/bin/say', '-v', 'Lilian', '你好']);
  assert.equal(env, undefined, '没有覆盖就不该下发 MMX_VOICE —— 主音色仍走外面的 voice 文件');
});

await test('音色覆盖：给了覆盖值就用它，并同时下发 MMX_VOICE（wrapper 只认这个）', () => {
  const voice = 'Chinese (Mandarin)_Radio_Host';
  const { argv, env } = buildSpeechArgv('darwin', '/usr/bin/say', '你好', { voice: 'Lilian', rate: 0, volume: 100 }, voice);
  assert.deepEqual(argv, ['/usr/bin/say', '-v', voice, '你好'], 'argv 用覆盖音色');
  assert.equal(env.MMX_VOICE, voice, '包内 wrapper 取最后一个 argv 当文本、忽略 -v，只能靠 MMX_VOICE');
});

await test('多会话音色（方案A）：第一个会话主音色，新开的会话拿备用音色', async () => {
  const ALT = 'Chinese (Mandarin)_Radio_Host';
  const subprocess = fakeSubprocess();
  const ctx = fakeCtx({ subprocess, llm: fakeLlm({ text: '在跑。' }) });
  apply(ctx, {
    throttleMs: 0, minGapMs: 0, silenceHeartbeatMs: 0, announceKickoff: false,
    voice: 'Lilian', voiceAlt: ALT, turnEndMinToolCalls: 1,
  });
  const announce = (session, id) => {
    ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
    ctx.emit('session/event', session, {
      type: 'todo/write',
      data: { todos: [{ content: 'x', status: 'completed' }] },
    });
  };
  const s1 = fakeSession('session-A');
  announce(s1, 'a');
  await tick(80);
  const s2 = fakeSession('session-B');
  announce(s2, 'b');
  await tick(80);

  const specs = subprocess.calls;
  assert.equal(specs.length, 2, `两个会话各应播一次：${specs.length}`);
  assert.ok(!(specs[0].env ?? {}).MMX_VOICE, '第一个会话是主音色，不该覆盖');
  assert.ok(specs[0].argv.includes('Lilian'), '第一个会话用配置里的主音色');
  assert.equal((specs[1].env ?? {}).MMX_VOICE, ALT, '第二个会话应换成备用音色');
  assert.ok(specs[1].argv.includes(ALT), 'argv 也应是备用音色');

  // 主音色会话退场后，下一个新会话应重新拿回主音色（否则单会话用户会听到声音漂移）
  ctx.emit('session/disposed', s1);
  const s3 = fakeSession('session-C');
  announce(s3, 'c');
  await tick(80);
  const last = subprocess.calls.at(-1);
  assert.ok(!(last.env ?? {}).MMX_VOICE, '主音色空出来后，新会话要拿回主音色');
  ctx.disposeAll();
});

await test('多会话音色：voiceAlt 留空即功能关闭（默认行为不变）', async () => {
  const subprocess = fakeSubprocess();
  const ctx = fakeCtx({ subprocess, llm: fakeLlm({ text: '在跑。' }) });
  apply(ctx, { throttleMs: 0, minGapMs: 0, silenceHeartbeatMs: 0, announceKickoff: false, voice: 'Lilian' });
  for (const id of ['session-A', 'session-B']) {
    const session = fakeSession(id);
    ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
    ctx.emit('session/event', session, { type: 'todo/write', data: { todos: [{ content: 'x', status: 'completed' }] } });
    await tick(80);
  }
  const specs = subprocess.calls;
  assert.equal(specs.length, 2, '两个会话各播一次');
  for (const spec of specs) {
    assert.ok(!(spec.env ?? {}).MMX_VOICE, 'voiceAlt 留空时任何会话都不该被覆盖');
    assert.ok(spec.argv.includes('Lilian'));
  }
  ctx.disposeAll();
});

// ── v1.4.2：状态短语（不念原始参数）+ 断点信号（审批 / 提问）──────────────
// 用户反馈 1：「你相当于是直接把原始指令读了出来，中文又夹杂着，感觉很奇怪。」
// 用户反馈 2：「我没有明确听到说这是一个需要我去审批或确认的断点。」

await test('状态短语：按真实频次分类，未收录的一律兜底，绝不出现英文工具名', () => {
  assert.equal(describeTool('bash'), '还在跑一条命令');
  assert.equal(describeTool('run_code'), '还在跑一段脚本');
  assert.equal(describeTool('job_output'), '还在等后台任务');
  assert.equal(describeTool('plugin_manager'), '还在装或查插件');
  assert.equal(describeTool('write'), '还在写文件');
  assert.equal(describeTool('web_fetch'), '还在读网页');
  assert.equal(describeTool('brand_new_tool'), '还在跑一个操作', '新工具要兜底，不能把英文名念出去');
  assert.equal(describeTool(undefined), '还在跑一个操作');
});

await test('状态短语：原始参数一个都不许进播报文本（拿真实那条命令当反例）', () => {
  const s = createSessionState('s');
  noteEvent(s, {
    type: 'tool/call',
    data: { callId: 'a', name: 'bash', arguments: JSON.stringify({ command: 'BEFORE=$(wc -l < ~/.dsh/dsh-stage-speak.log); echo "开始 UTC $(date -u +%H:%M:%S)"' }) },
  }, {});
  const line = pendingWorkLine(s, s.inFlightCalls[0].at + 62000);
  assert.equal(line, '还在跑一条命令，已经 1 分 2 秒');
  for (const banned of ['wc -l', 'BEFORE', '$(', '~/.dsh', 'bash', 'echo']) {
    assert.ok(!line.includes(banned), `播报里出现了原始内容「${banned}」：${line}`);
  }
});

await test('审批断点：确定性信号在前，且等待期不许再播"在干活"', async () => {
  const subprocess = fakeSubprocess();
  const ctx = fakeCtx({ subprocess, llm: fakeLlm({ text: '要改本地 git 代理配置。' }) });
  apply(ctx, HCFG);
  const session = fakeSession();
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  // 实测 17/17：审批发生时**总有**工具在飞 —— 正是旧逻辑把它报成"还在跑命令"的原因
  ctx.emit('session/event', session, { type: 'tool/call', data: { callId: 'c1', name: 'bash' } });
  ctx.emit('session/event', session, {
    type: 'approval/asked',
    data: { toolName: 'bash', reason: 'escalate sandbox to danger-full-access: 必须给 git 配置代理，否则同步通道不可用。' },
  });
  await tick(600);
  const spoken = subprocess.calls.map((c) => c.argv.at(-1));
  assert.equal(spoken.length, 1, `审批只应播一次，实际：${JSON.stringify(spoken)}`);
  assert.ok(spoken[0].startsWith(APPROVAL_SIGNAL), `必须明确说出这是断点：${spoken[0]}`);
  // 等待审批期间：球在用户手上 → 不许再播
  await tick(900);
  assert.equal(subprocess.calls.length, 1, '审批等待期必须静默');
  // 批了之后恢复心跳能力
  ctx.emit('session/event', session, { type: 'approval/decided', data: {} });
  await tick(900);
  assert.ok(subprocess.calls.length > 1, '审批结束后应恢复播报能力');
  ctx.disposeAll();
});

await test('提问断点：ask_user_question 也是断点（不是中间过程），等待期静默', async () => {
  const subprocess = fakeSubprocess();
  const ctx = fakeCtx({ subprocess, llm: fakeLlm({ text: '问你要不要继续用旧目录。' }) });
  apply(ctx, HCFG);
  const session = fakeSession();
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  ctx.emit('session/event', session, { type: 'tool/call', data: { callId: 'q1', name: 'ask_user_question', arguments: '{"questions":[]}' } });
  await tick(600);
  const spoken = subprocess.calls.map((c) => c.argv.at(-1));
  assert.equal(spoken.length, 1, `提问只应播一次，实际：${JSON.stringify(spoken)}`);
  assert.ok(spoken[0].startsWith(ASK_USER_SIGNAL), `必须明确说出这是断点：${spoken[0]}`);
  await tick(900);
  assert.equal(subprocess.calls.length, 1, '等用户回答期间必须静默（实测中位 49 秒、最长 540 秒）');
  ctx.disposeAll();
});

await test('审批文本清洗：剥掉纯英文机器前缀，只留中文说明', () => {
  assert.equal(
    cleanApprovalReason('escalate sandbox to danger-full-access: Air 本机直连 github.com 被阻断，必须配置代理。'),
    'Air 本机直连 github.com 被阻断，必须配置代理。',
  );
  assert.equal(cleanApprovalReason('这已经是中文：不要剥掉'), '这已经是中文：不要剥掉', '含汉字的前缀不能当机器前缀');
  assert.equal(cleanApprovalReason(''), '');
  assert.equal(cleanApprovalReason(undefined), '');
  assert.ok(cleanApprovalReason('x'.repeat(400)).length <= 161, '过长的原因要截断，免得播报变成长文');
});

await test('事实型播报的守卫：事实自己也要"够有料"，不许念「已经 4 秒」', async () => {
  // 线上实测（2026-10-01 07:15，重启后的首次验证）：久静默之后紧接着一次新的模型调用，
  // 心跳因"距上次播报已超阈值"而触发，话术却念出「还在等模型返回，已经 4 秒」。
  const subprocess = fakeSubprocess();
  const ctx = fakeCtx({ subprocess, llm: fakeLlm({ text: '在跑。' }) });
  apply(ctx, HCFG); // silenceHeartbeatMs 300 / tick 200
  const session = fakeSession();
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  ctx.emit('session/event', session, { type: 'tool/call', data: { callId: 'c1', name: 'bash' } });
  await tick(500); // 第一次心跳（缓冲有内容 → 走摘要）
  const afterFirst = subprocess.calls.length;
  assert.ok(afterFirst >= 1, '第一次心跳应播');
  ctx.emit('session/event', session, { type: 'tool/result', data: { toolCallId: 'c1' } });
  await tick(400); // 此后无任何活动 → 三态皆空，正确沉默
  assert.equal(subprocess.calls.length, afterFirst, '无活动期间不该播');
  // 静默已久，此刻开一次新的模型调用：这条事实只有 ~200ms 大 → 不许开口
  ctx.emit('session/event', session, { type: 'step/start', data: { turn: 1, step: 2 } });
  await tick(200);
  assert.equal(subprocess.calls.length, afterFirst, '刚开的模型调用不值得播报');
  // 等这条事实自己长过阈值 → 才出声（此时才轮到它）
  await tick(600);
  assert.equal(
    subprocess.calls.length,
    afterFirst + 1,
    '事实够久后应恰好出声一次（说明前面压住它的是"事实太新"，不是别的）',
  );
  const last = subprocess.calls.map((c) => c.argv.at(-1)).at(-1) ?? '';
  assert.ok(last.includes('还在等模型返回'), `应念等待态话术：${last}`);
  ctx.disposeAll();
});

await test('事实型播报的守卫：期间若来了新事件，改走摘要而不念那句可能已过时的话', async () => {
  const subprocess = fakeSubprocess();
  const llm = fakeLlm({ text: '刚生成完一段回复。' });
  const ctx = fakeCtx({ subprocess, llm });
  apply(ctx, { ...HCFG, throttleMs: 400 });
  const session = fakeSession();
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  ctx.emit('session/event', session, { type: 'step/start', data: { turn: 1, step: 1 } });
  await tick(500); // tick(400) 已判定出心跳，flush 排在 800
  ctx.emit('session/event', session, {
    type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'text', text: '做完了。' }] } },
  });
  await tick(400);
  const spoken = subprocess.calls.map((c) => c.argv.at(-1)).join('');
  assert.equal(llm.seen.length, 1, '缓冲里有新内容时应走摘要模型');
  assert.ok(spoken.includes('刚生成完一段回复'), `应念摘要：${spoken}`);
  assert.ok(!spoken.includes('还在等模型返回'), '不该再念那句已经过时的事实描述');
  ctx.disposeAll();
});

await test('静默心跳守卫：轮次已结束不报', async () => {
  const subprocess = fakeSubprocess();
  const ctx = fakeCtx({ subprocess, llm: fakeLlm() });
  apply(ctx, HCFG);
  const session = fakeSession();
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  ctx.emit('session/event', session, { type: 'tool/call', data: { name: 'bash' } });
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await tick(800);
  assert.equal(subprocess.calls.length, 0, '轮次结束后不该播心跳');
  ctx.disposeAll();
});

await test('silenceHeartbeatMs=0 时完全不启动心跳', async () => {
  const subprocess = fakeSubprocess();
  const ctx = fakeCtx({ subprocess, llm: fakeLlm() });
  apply(ctx, { ...HCFG, silenceHeartbeatMs: 0 });
  const session = fakeSession();
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  ctx.emit('session/event', session, { type: 'tool/call', data: { name: 'bash' } });
  await tick(800);
  assert.equal(subprocess.calls.length, 0, '关闭心跳后不该有任何播报');
  ctx.disposeAll();
});

await test('会话销毁会清掉该会话的待播定时器', async () => {
  const subprocess = fakeSubprocess();
  const ctx = fakeCtx({ subprocess, llm: fakeLlm() });
  apply(ctx, { throttleMs: 40, minGapMs: 0 });

  const session = fakeSession();
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  ctx.emit('session/event', session, { type: 'tool/call', data: { name: 'bash' } });
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  ctx.emit('session/disposed', session);
  await tick(120);
  assert.equal(subprocess.calls.length, 0, '会话销毁后不该还有播报');
  ctx.disposeAll();
});

console.log('\n── 8. 全双工端到端（mode: full，假宿主 + 真临时目录）──');

/**
 * 全双工端到端配置。
 * ⚠️ `audioCorePath` 指向包内 shell 文件而不是编译产物：`engine/audio-core` 是编译出来的、
 *    不入库，不能当测试前置条件（沿用 5c 已有的做法）。
 */
const FULL_CFG = { throttleMs: 0, minGapMs: 0, mode: 'full', audioCorePath: './engine/minimax-speak.sh' };

/** 写一个**规范的** 16kHz 单声道 PCM16 WAV（44 字节头）到指定目录。 */
function writeTestWav(dir, name, samples = 1600) {
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(samples * 2, 40);
  const file = path.join(dir, name);
  fs.writeFileSync(file, buffer);
  return file;
}

await test('全双工 e2e①：mode=full 时内核带 ASR_ENABLED/ASR_UTTERANCE_DIR，且目录已建好', () => {
  const subprocess = fakeSubprocess();
  const ctx = fakeCtx({ subprocess, llm: fakeLlm(), agents: fakeAgents(), speechToText: fakeSpeechToText() });
  apply(ctx, FULL_CFG);

  assert.equal(subprocess.coreCalls.length, 1, 'full 档应起一个常驻内核');
  const spec = subprocess.coreCalls[0];
  assert.equal(spec.env?.ASR_ENABLED, '1', 'full 档必须让内核分句落盘');
  const dir = spec.env?.ASR_UTTERANCE_DIR;
  assert.ok(typeof dir === 'string' && dir.length > 0, `ASR_UTTERANCE_DIR 必须非空：${dir}`);
  // ⚠️ 目录必须先建好：漏建的话内核每句都落盘失败，而事件里只说 utterance-failed —— 全双工静默失效。
  assert.ok(fs.existsSync(dir), `录音目录必须已被建好：${dir}`);
  ctx.disposeAll();
});

await test('全双工 e2e②：mode=half 不带 ASR 环境变量（半双工零回归）', () => {
  const subprocess = fakeSubprocess();
  const ctx = fakeCtx({ subprocess, llm: fakeLlm() });
  apply(ctx, { ...baseConfig(), mode: 'half', audioCorePath: './engine/minimax-speak.sh' });
  assert.equal(subprocess.coreCalls.length, 1, 'half 档应起内核（只做 VAD）');
  assert.equal(subprocess.coreCalls[0].env?.ASR_ENABLED, undefined, '半双工不许让内核分句');
  assert.equal(subprocess.coreCalls[0].env?.ASR_UTTERANCE_DIR, undefined);
  ctx.disposeAll();
});

await test('全双工 e2e③：内核报 utterance-file → 本地识别 → steer 注入（播报不受影响）', async () => {
  const subprocess = fakeSubprocess({ stdoutText: '/tmp/spoken.mp3\n' });
  const speechToText = fakeSpeechToText({ text: '把构建脚本再跑一遍' });
  const agents = fakeAgents();
  const ctx = fakeCtx({ subprocess, llm: fakeLlm(), agents, speechToText });
  apply(ctx, FULL_CFG);

  const session = fakeSession('sfull');
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  // 内核侧：先真的写一个 WAV 到它自己的录音目录，再报事件 —— 走真实的读文件 + 删文件路径。
  const dir = subprocess.coreCalls[0].env.ASR_UTTERANCE_DIR;
  const wav = writeTestWav(dir, 'utt-000001.wav');
  subprocess.kernels[0].stdout.write(`${JSON.stringify({ ev: 'utterance-file', path: wav, id: 'utt-000001.wav', seconds: 0.1, reason: 'silence' })}\n`);
  await tick(40);

  assert.equal(speechToText.resolved.length, 1, '内核报一句，就该识别一句');
  assert.equal(speechToText.resolved[0].language, 'zh', 'language 必须是配置的 zh');
  assert.equal(agents.steered.length, 1, '识别文本应经 steer 注入');
  assertUserMessageShape(agents.steered[0].message);
  assert.equal(agents.steered[0].message.content[0].text, '把构建脚本再跑一遍');
  assert.equal(agents.steered[0].id, 'sfull', '注入给最近有活动的那条会话');
  assert.equal(fs.existsSync(wav), false, '识别完要删掉临时录音');

  // 同一句重发一次：不许注入两遍。
  subprocess.kernels[0].stdout.write(`${JSON.stringify({ ev: 'utterance-file', path: wav, id: 'utt-000001.wav', seconds: 0.1, reason: 'silence' })}\n`);
  await tick(20);
  assert.equal(agents.steered.length, 1, `同一句只许注入一次，实际 ${agents.steered.length}`);
  assert.equal(speechToText.transcribed.length, 1, '重复事件不该再识别一遍');

  // 识别通路不许把播报搞哑：照旧走一轮播报。
  ctx.emit('session/event', session, { type: 'tool/call', data: { name: 'bash' } });
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await tick(80);
  assert.ok(subprocess.calls.length >= 1, `全双工下播报仍要出声，实际 ${subprocess.calls.length}`);
  ctx.disposeAll();
});

await test('全双工 e2e④：识别失败不抛错、不影响会话，播报照旧', async () => {
  const subprocess = fakeSubprocess({ stdoutText: '/tmp/spoken.mp3\n' });
  const speechToText = fakeSpeechToText({ fail: true });
  const agents = fakeAgents();
  const ctx = fakeCtx({ subprocess, llm: fakeLlm(), agents, speechToText });
  apply(ctx, FULL_CFG);

  const session = fakeSession('sfail');
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  const dir = subprocess.coreCalls[0].env.ASR_UTTERANCE_DIR;
  const wav = writeTestWav(dir, 'utt-000002.wav');
  assert.doesNotThrow(() => {
    subprocess.kernels[0].stdout.write(`${JSON.stringify({ ev: 'utterance-file', path: wav, id: 'utt-000002.wav', seconds: 0.1, reason: 'silence' })}\n`);
  });
  await tick(40);
  assert.equal(agents.steered.length, 0, '识别失败不许注入');
  assert.equal(fs.existsSync(wav), false, '识别失败也要清掉临时录音');

  ctx.emit('session/event', session, { type: 'tool/call', data: { name: 'bash' } });
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await tick(80);
  assert.ok(subprocess.calls.length >= 1, `识别失败不许影响播报，实际 ${subprocess.calls.length}`);
  ctx.disposeAll();
});

await test('全双工 e2e⑤：缺 speechToText 服务 → 只 warn + 留痕，内核照起、播报照旧', async () => {
  const warns = [];
  const logFile = path.join(os.tmpdir(), `dsh-stage-speak-duplex-${process.pid}-${Date.now()}.log`);
  try { fs.rmSync(logFile, { force: true }); } catch { /* 忽略 */ }
  const subprocess = fakeSubprocess({ stdoutText: '/tmp/spoken.mp3\n' });
  // 刻意**不给** speechToText：模拟"没装语音 bundle 的机器"。
  const ctx = fakeCtx({ subprocess, llm: fakeLlm(), agents: fakeAgents() });
  ctx.logger.warn = (message) => warns.push(String(message));
  apply(ctx, { ...FULL_CFG, logFile });

  assert.ok(warns.some((message) => message.includes('全双工已关闭')), `服务缺失必须 warn：${JSON.stringify(warns)}`);
  const journalText = fs.readFileSync(logFile, 'utf8');
  assert.ok(journalText.includes('duplex-unavailable'), `必须留痕（不然是静默失效）：\n${journalText}`);
  assert.equal(subprocess.coreCalls.length, 1, '内核照起（半双工让路仍然可用）');
  assert.equal(subprocess.coreCalls[0].env?.ASR_ENABLED, undefined, '没有识别服务就不该让内核分句落盘');

  const session = fakeSession('snosvc');
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  ctx.emit('session/event', session, { type: 'tool/call', data: { name: 'bash' } });
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await tick(80);
  assert.ok(subprocess.calls.length >= 1, `缺识别服务时播报必须照旧，实际 ${subprocess.calls.length}`);
  ctx.disposeAll();
  try { fs.rmSync(logFile, { force: true }); } catch { /* 忽略 */ }
});

await test('全双工防回退：inject 里不得出现 speechToText / agents', async () => {
  const module = await import('../lib/index.js');
  assert.deepEqual(module.inject, ['subprocess'], `inject 只该有 subprocess，实际 ${JSON.stringify(module.inject)}`);
  for (const name of ['speechToText', 'agents']) {
    assert.ok(!module.inject.includes(name),
      `${name} 不能进 inject：cordis 的 inject 无 optional 语义，缺这一个服务会让整个插件不激活（连默认档播报都没了）`);
  }
});

console.log('\n── 9. 配置热更新（拨档位不生效的真机缺陷）──');

/**
 * 造一个带**活配置**的假宿主：`ctx.fiber.config` 就是面板保存时被原地改写的那个对象。
 *
 * 真机机制（源码逐字读过）：`cordis-plugin-loader._commitVolatile()` 对 volatile 字段走快路径 ——
 * 把新值 `updateVolatile(ref, source)` 写进 `fiber.config` 的活访问器，然后直接 return，
 * **不重挂载插件、不重跑 apply**。所以插件只能自己比对活配置。
 */
function hotCtx({ subprocess, llm, agents, speechToText, liveConfig }) {
  const ctx = fakeCtx({ subprocess, llm, agents, speechToText });
  ctx.fiber = { config: liveConfig };
  return ctx;
}

/** 热更新用例的活配置基线（看门狗 50ms，跑得快）。 */
function liveCfg(overrides = {}) {
  return {
    throttleMs: 0,
    minGapMs: 0,
    mode: 'off',
    modeWatchMs: 50,
    audioCorePath: './engine/minimax-speak.sh',
    ...overrides,
  };
}

/** 收内核 stdin 上的命令（用来断言"旧内核有没有被 quit"）。 */
function watchKernelCommands(kernel) {
  const commands = [];
  kernel.stdin.on('data', (chunk) => commands.push(String(chunk)));
  return commands;
}

/** 建一个临时 journal 文件，返回路径与读取/清理器。 */
function tempJournal(tag) {
  const file = path.join(os.tmpdir(), `dsh-stage-speak-${tag}-${process.pid}-${Date.now()}.log`);
  try { fs.rmSync(file, { force: true }); } catch { /* 忽略 */ }
  return {
    file,
    read: () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''),
    clean: () => { try { fs.rmSync(file, { force: true }); } catch { /* 忽略 */ } },
  };
}

await test('热更新①：看门狗发现 mode off→full → 起内核且带 ASR_ENABLED（不必重启宿主）', async () => {
  const subprocess = fakeSubprocess();
  const live = liveCfg();
  const ctx = hotCtx({
    subprocess, llm: fakeLlm(), agents: fakeAgents(), speechToText: fakeSpeechToText(), liveConfig: live,
  });
  apply(ctx, { ...live });
  assert.equal(subprocess.coreCalls.length, 0, '启动时是「原始」档，不该起内核');

  live.mode = 'full'; // ← 等价于面板保存：只改活配置，apply 不再跑
  await tick(200);

  assert.equal(subprocess.coreCalls.length, 1, `看门狗应把内核起起来，实际 ${subprocess.coreCalls.length}`);
  assert.equal(subprocess.coreCalls[0].env?.ASR_ENABLED, '1', 'full 档要让内核分句落盘');
  assert.ok(String(subprocess.coreCalls[0].env?.ASR_UTTERANCE_DIR ?? '').length > 0, '并给出录音目录');
  ctx.disposeAll();
});

await test('热更新②：看门狗发现 full→off → 旧内核被拆掉（收到 quit、不再有内核）', async () => {
  const subprocess = fakeSubprocess();
  const live = liveCfg({ mode: 'full' });
  const ctx = hotCtx({
    subprocess, llm: fakeLlm(), agents: fakeAgents(), speechToText: fakeSpeechToText(), liveConfig: live,
  });
  apply(ctx, { ...live });
  assert.equal(subprocess.coreCalls.length, 1, 'full 档启动就该起内核');
  const commands = watchKernelCommands(subprocess.kernels[0]);

  live.mode = 'off';
  await tick(200);

  assert.ok(commands.join('').includes('"cmd":"quit"'), `旧内核必须收到 quit：${JSON.stringify(commands)}`);
  assert.equal(subprocess.coreCalls.length, 1, '不该再起第二个内核');
  // 切回原始档后播报照旧，且**不**再走"只合成不播放"的内核路径。
  const session = fakeSession('shot');
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  ctx.emit('session/event', session, { type: 'tool/call', data: { name: 'bash' } });
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await tick(80);
  assert.ok(subprocess.calls.length >= 1, `切档后播报仍要出声，实际 ${subprocess.calls.length}`);
  assert.equal(subprocess.calls.at(-1).env?.MMX_SYNTH_ONLY, undefined, '原始档应回到 wrapper 自播');
  ctx.disposeAll();
});

await test('热更新③：只改非关键键 → 不重建通路，但新值当场生效', async () => {
  const subprocess = fakeSubprocess();
  const journalFile = tempJournal('hot3');
  const live = liveCfg({ mode: 'half', logFile: journalFile.file });
  const ctx = hotCtx({
    subprocess, llm: fakeLlm(), agents: fakeAgents(), speechToText: fakeSpeechToText(), liveConfig: live,
  });
  apply(ctx, { ...live });
  assert.equal(subprocess.coreCalls.length, 1, 'half 档应起内核（只做 VAD）');
  const commands = watchKernelCommands(subprocess.kernels[0]);
  const journalText0 = journalFile.read();

  // ⚠️ 只改**不影响调度**的非关键键：`throttleMs` 也是活配置，改大它会把播报推到 10 秒后，
  //    那样这条用例就测不到播报了。`graceMs` 引擎在 spawn 时读它，正好能证明新值当场生效。
  live.graceMs = 12345;
  await tick(200);

  assert.equal(subprocess.coreCalls.length, 1, '非关键键变化不该重建通路（更不该重启内核）');
  assert.deepEqual(commands, [], '旧内核不该收到任何命令（尤其不许 quit）');
  assert.equal(journalFile.read(), journalText0, '不该有新的重建留痕（journal 一个字都不该多）');

  // 但配置本身必须热生效：重新播一次，spawn 规格里的 graceMs 应是新值。
  const session = fakeSession('shot2');
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  ctx.emit('session/event', session, { type: 'tool/call', data: { name: 'bash' } });
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await tick(80);
  assert.equal(subprocess.calls.at(-1)?.graceMs, 12345, '活配置里的 graceMs 必须当场生效');
  ctx.disposeAll();
  journalFile.clean();
});

await test('热更新④：ctx.fiber 不存在时不抛错，退回"启动时判定一次"', async () => {
  const subprocess = fakeSubprocess();
  // 刻意**不给** fiber：非 Loader 挂载 / 老宿主。
  const ctx = fakeCtx({ subprocess, llm: fakeLlm(), agents: fakeAgents(), speechToText: fakeSpeechToText() });
  let error = null;
  try {
    apply(ctx, { mode: 'full', modeWatchMs: 50, throttleMs: 0, minGapMs: 0, audioCorePath: './engine/minimax-speak.sh' });
  } catch (thrown) {
    error = thrown;
  }
  assert.equal(error, null, `没有 fiber 不许抛错：${error?.message}`);
  await tick(200); // 让看门狗空转几拍

  assert.equal(subprocess.coreCalls.length, 1, '退回启动时判定一次：一个内核，不多不少');
  const session = fakeSession('snofib');
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  ctx.emit('session/event', session, { type: 'tool/call', data: { name: 'bash' } });
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await tick(80);
  assert.ok(subprocess.calls.length >= 1, '播报照旧');
  ctx.disposeAll();
});

await test('热更新⑤：loader/volatile-update 事件即时生效（看门狗关掉也能切档）', async () => {
  const subprocess = fakeSubprocess();
  const live = liveCfg({ modeWatchMs: 0 }); // 关掉看门狗 → 只剩事件这条路
  const ctx = hotCtx({
    subprocess, llm: fakeLlm(), agents: fakeAgents(), speechToText: fakeSpeechToText(), liveConfig: live,
  });
  apply(ctx, { ...live });
  assert.equal(subprocess.coreCalls.length, 0);

  live.mode = 'full';
  ctx.emit('loader/volatile-update', [['mode']]);
  await tick(30);

  assert.equal(subprocess.coreCalls.length, 1, '事件应即时触发重建（不必等轮询）');
  ctx.disposeAll();
});

await test('热更新⑥：活配置是访问器形状（DSH 就是写活访问器）时同样能发现变化', async () => {
  const subprocess = fakeSubprocess();
  let mode = 'off';
  // 模拟 updateVolatile：值存在访问器里，热更新改写的是访问器的值。
  const live = { ...liveCfg(), mode: { get: () => mode } };
  const ctx = hotCtx({
    subprocess, llm: fakeLlm(), agents: fakeAgents(), speechToText: fakeSpeechToText(), liveConfig: live,
  });
  apply(ctx, { mode: 'off', modeWatchMs: 50, throttleMs: 0, minGapMs: 0, audioCorePath: './engine/minimax-speak.sh' });
  assert.equal(subprocess.coreCalls.length, 0);

  mode = 'full';
  await tick(200);
  assert.equal(subprocess.coreCalls.length, 1, '访问器形状的活配置同样要被读到');
  ctx.disposeAll();
});

await test('热更新⑦：只改 duplexLanguage → 只换识别半边，内核不重启、不重复挂监听', async () => {
  const subprocess = fakeSubprocess();
  const speechToText = fakeSpeechToText({ text: '换语言之后照样识别' });
  const agents = fakeAgents();
  const live = liveCfg({ mode: 'full' });
  const ctx = hotCtx({ subprocess, llm: fakeLlm(), agents, speechToText, liveConfig: live });
  apply(ctx, { ...live });
  assert.equal(subprocess.coreCalls.length, 1);

  live.duplexLanguage = 'en';
  await tick(200);
  assert.equal(subprocess.coreCalls.length, 1, '只改语言不该重启内核（省掉重新起麦+校准）');

  // 注入目标 =「最近有活动的会话」，所以先喂一条会话事件（否则会因 no-target 拒绝注入）。
  const session = fakeSession('slang');
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });

  // 内核侧照旧报一句 → 必须**只**被处理一次（重复挂监听会让同一句进两次）。
  const dir = subprocess.coreCalls[0].env.ASR_UTTERANCE_DIR;
  const wav = writeTestWav(dir, 'utt-000009.wav');
  subprocess.kernels[0].stdout.write(`${JSON.stringify({ ev: 'utterance-file', path: wav, id: 'utt-000009.wav', seconds: 0.1, reason: 'silence' })}\n`);
  await tick(40);

  assert.equal(speechToText.resolved.length, 1, `同一句只该识别一次，实际 ${speechToText.resolved.length}`);
  assert.equal(speechToText.resolved[0].language, 'en', '新语言必须已生效');
  assert.equal(agents.steered.length, 1, '同一句只该注入一次');
  ctx.disposeAll();
});

await test('热更新⑧：来回切换多轮不泄漏内核（每轮恰好一个新内核，旧的都收到 quit）', async () => {
  const subprocess = fakeSubprocess();
  const journalFile = tempJournal('hot8');
  // ⚠️ logFile 要写进**同一个** live 对象：给 ctx.fiber.config 传副本的话，
  //    后面 `live.mode = ...` 就改不到插件真正读的那个对象了。
  const live = liveCfg({ logFile: journalFile.file });
  const ctx = hotCtx({
    subprocess, llm: fakeLlm(), agents: fakeAgents(), speechToText: fakeSpeechToText(), liveConfig: live,
  });
  apply(ctx, { ...live });

  const quitFlags = [];
  let watched = 0;
  for (const mode of ['full', 'off', 'full']) {
    live.mode = mode;
    await tick(200);
    // 起新内核的那一轮才登记监听（切回 `off` 时不产生新内核 —— 这正是要验证的）。
    if (subprocess.kernels.length > watched) {
      watched = subprocess.kernels.length;
      quitFlags.push(watchKernelCommands(subprocess.kernels.at(-1)));
    }
  }
  // 三轮切换：full 起 1 个 → off 拆掉 → full 再起 1 个 = 共 2 个内核。
  assert.equal(subprocess.coreCalls.length, 2, `每轮只该有一个新内核，实际 ${subprocess.coreCalls.length}`);
  assert.ok(quitFlags[0].join('').includes('"cmd":"quit"'), '第一个内核被切走时必须收到 quit');
  assert.deepEqual(quitFlags.at(-1), [], '最后那个内核是当前在用的，不该收到 quit');

  const journalText = journalFile.read();
  const changes = journalText.split('\n').filter((line) => line.includes('duplex-mode-changed'));
  // 三次切换（off→full→off→full）各留一条痕（启动那次不算变化）。
  assert.equal(changes.length, 3, `三次档位变化要各留一条痕，实际 ${changes.length}：\n${journalText}`);
  assert.ok(changes[0].includes('from=off|kernel=0|duplex=0'), `留痕要带 from：${changes[0]}`);
  assert.ok(changes[0].includes('to=full|kernel=1|duplex=1'), `留痕要带 to：${changes[0]}`);
  assert.ok(changes.every((line) => line.includes('trigger=watchdog')), `留痕要带触发来源：\n${changes.join('\n')}`);
  ctx.disposeAll();
  journalFile.clean();
});

console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${passed} / ${passed + failed}${failed > 0 ? `，失败 ${failed}` : ''}`);
process.exit(failed > 0 ? 1 : 0);
