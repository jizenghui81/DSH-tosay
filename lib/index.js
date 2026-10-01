// index.js — dsh-stage-speak 插件入口（host 半边，纯 ESM，无构建步骤）。
//
// 目标：让助手在"每完成一个阶段"时，用一句人话把进展说出来，而不是把回复原文念一遍。
//
// 数据流：
//   session/event ──► activity.noteEvent   判断是不是阶段边界
//                        │
//                        ├─ 防抖合并（throttleMs）+ 最小间隔（minGapMs）
//                        ▼
//                  summarize.summarize     LLM 压成一句话；失败退规则摘要
//                        ▼
//                  engine.speak            系统语音串行播报，忙时合并、急事插队
//
// 设计底线：任何一步失败都只记日志。播报是锦上添花，绝不能影响会话本身。

import Schema from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import { PRIORITY, createSessionState, drain, noteEvent, pendingWorkLine } from './activity.js';
import { summarize } from './summarize.js';
import { createSpeechEngine } from './engine.js';
import { createJournal } from './journal.js';

/** 插件名，同时是 Loader 行 id 与设置命名空间。 */
export const name = 'dsh-stage-speak';

/**
 * 硬依赖只有子进程（要调系统语音引擎）。
 * llm 走 ctx.get() 可选获取：没有摘要模型时自动退化成规则摘要，而不是加载失败。
 */
export const inject = ['subprocess'];

/** 配置契约。带 volatile() 的字段会被投影到 DSH 的设置页。 */
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).volatile(),
  // —— 播报什么 ——
  announceTurnEnd: Schema.boolean().default(true).volatile(),
  // 开工反馈：接到新任务的第一时间给"收到 + 思路"的口头确认
  announceKickoff: Schema.boolean().default(true).volatile(),
  kickoffThrottleMs: Schema.number().default(400).volatile(),
  kickoffMinTaskChars: Schema.number().default(4).volatile(),
  // 静默心跳：本轮进行中、且超过这么久没播报过，就报一次进展（0 = 关闭）
  silenceHeartbeatMs: Schema.number().default(30000).volatile(),
  announceTodoCompleted: Schema.boolean().default(true).volatile(),
  announceApprovals: Schema.boolean().default(true).volatile(),
  announceGoalChange: Schema.boolean().default(false).volatile(),
  includeSubagents: Schema.boolean().default(false).volatile(),
  // 按错误码过滤「按设计可自愈」的工具报错（真实会话回放校准出来的默认值：
  // FS_NOT_OBSERVED = 先读后写策略、FS_STALE_VERSION = 版本过期需重放）
  toolErrorIgnoreCodes: Schema.array(Schema.string()).default(['FS_NOT_OBSERVED', 'FS_STALE_VERSION']).volatile(),
  // 真实数据里工具报错很常见且多可自愈，默认不打断当前播报
  toolErrorPriority: Schema.union(['normal', 'high']).default('normal').volatile(),
  // —— 什么时候播报（节奏）——
  throttleMs: Schema.number().default(2500).volatile(),
  minGapMs: Schema.number().default(6000).volatile(),
  stageToolCalls: Schema.number().default(8).volatile(),
  turnEndMinToolCalls: Schema.number().default(1).volatile(),
  // —— 怎么摘要 ——
  useLlmSummary: Schema.boolean().default(true).volatile(),
  llmTimeoutMs: Schema.number().default(15000).volatile(),
  summaryProvider: Schema.string().default('').volatile(),
  summaryModel: Schema.string().default('').volatile(),
  maxChars: Schema.number().default(120).volatile(),
  // —— 用什么声音 ——
  voice: Schema.string().default('').volatile(),
  rate: Schema.number().default(0).volatile(),
  volume: Schema.number().default(100).volatile(),
  engine: Schema.string().default('').volatile(),
  // —— 运维 ——
  // 语音子进程的工作目录。SubprocessSpawnSpec 要求 cwd 必填；留空 = 用户主目录。
  cwd: Schema.string().default(''),
  graceMs: Schema.number().default(4000),
  speakTimeoutMs: Schema.number().default(120000),
  logAnnouncements: Schema.boolean().default(false).volatile(),
  logFile: Schema.string().default('').volatile(),
});

/** 每个字段的默认值，与上面的 schema 保持一致（没有 schema 时也能跑）。 */
const DEFAULTS = {
  enabled: true,
  announceTurnEnd: true,
  announceKickoff: true,
  kickoffThrottleMs: 400,
  kickoffMinTaskChars: 4,
  silenceHeartbeatMs: 30000,
  announceTodoCompleted: true,
  announceApprovals: true,
  announceGoalChange: false,
  includeSubagents: false,
  toolErrorIgnoreCodes: ['FS_NOT_OBSERVED', 'FS_STALE_VERSION'],
  toolErrorPriority: 'normal',
  throttleMs: 2500,
  minGapMs: 6000,
  stageToolCalls: 8,
  turnEndMinToolCalls: 1,
  useLlmSummary: true,
  llmTimeoutMs: 15000,
  summaryProvider: '',
  summaryModel: '',
  maxChars: 120,
  voice: '',
  rate: 0,
  volume: 100,
  engine: '',
  cwd: '',
  graceMs: 4000,
  speakTimeoutMs: 120000,
  logAnnouncements: false,
  logFile: '',
};

/**
 * 读一个配置字段，同时兼容 schemastery 的访问器对象与普通值。
 * （DSH 不同版本传进来的形状不同：0.1.7+ 是带 .get() 的访问器。）
 * @param {unknown} source - 传给 apply 的 config。
 * @param {string} key - 字段名。
 * @param {unknown} fallback - 缺省值。
 * @returns {unknown} 解析后的值。
 */
export function readField(source, key, fallback) {
  const raw = source === undefined || source === null ? undefined : source[key];
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === 'object' && typeof raw.get === 'function') {
    try {
      const inner = raw.get();
      return inner === undefined || inner === null ? fallback : inner;
    } catch {
      return fallback;
    }
  }
  return raw;
}

/**
 * 展开开头的 `~`。
 *
 * 为什么需要：配置里的路径值不经过 shell，Node 也不会替你展开 `~`。
 * 而包内默认配置要跨机器可用，不能写死绝对路径 —— 于是允许写 `~/...`。
 *
 * @param {unknown} value - 原始值。
 * @returns {string} 展开后的字符串（非字符串一律返回空串）。
 */
export function expandHome(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (s === '~') return homedir();
  if (s.startsWith('~/')) return `${homedir()}/${s.slice(2)}`;
  return s;
}

/**
 * 把任意输入补齐成完整配置，并把数值字段钳制到合法区间。
 * @param {unknown} source - 传给 apply 的 config。
 * @returns {object} 完整且合法的配置。
 */
export function resolveConfig(source) {
  const out = {};
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = readField(source, key, fallback);
    if (Array.isArray(fallback)) {
      out[key] = Array.isArray(value)
        ? value.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
        : [...fallback];
    } else if (typeof fallback === 'number') {
      out[key] = Number.isFinite(value) ? Number(value) : fallback;
    } else if (typeof fallback === 'boolean') {
      out[key] = value === true;
    } else {
      out[key] = String(value);
    }
  }
  out.throttleMs = Math.max(0, out.throttleMs);
  out.kickoffThrottleMs = Math.max(0, out.kickoffThrottleMs);
  out.kickoffMinTaskChars = Math.max(0, Math.round(out.kickoffMinTaskChars));
  out.silenceHeartbeatMs = Math.max(0, out.silenceHeartbeatMs);
  out.minGapMs = Math.max(0, out.minGapMs);
  out.stageToolCalls = Math.max(0, Math.round(out.stageToolCalls));
  out.turnEndMinToolCalls = Math.max(0, Math.round(out.turnEndMinToolCalls));
  out.maxChars = Math.max(0, Math.round(out.maxChars));
  out.llmTimeoutMs = Math.max(0, out.llmTimeoutMs);
  out.rate = Math.max(0, out.rate);
  out.volume = Math.max(0, Math.min(100, out.volume));
  // 路径类字段允许写 `~/...`：包内默认配置要跨机器可用，不能写死绝对路径。
  for (const key of ['logFile', 'engine', 'cwd']) out[key] = expandHome(out[key]);
  return out;
}

/** 从任意模型选择对象里抠出 provider/model。 */
function selectionOf(value) {
  if (value === undefined || value === null || typeof value !== 'object') return {};
  const provider = typeof value.provider === 'string' ? value.provider : '';
  const model = typeof value.model === 'string' ? value.model : '';
  return { provider, model };
}

/**
 * 挂载插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主插件上下文。
 * @param {unknown} rawConfig - Loader 行配置。
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig);
  const logger = ctx.logger;

  const warn = (message, detail) => {
    try {
      logger?.warn(`dsh-stage-speak: ${message}${detail === undefined ? '' : ` (${String(detail)})`}`);
    } catch { /* 忽略 */ }
  };

  if (!config.enabled) {
    try { logger?.info('dsh-stage-speak: 已禁用，不注册任何监听'); } catch { /* 忽略 */ }
    return;
  }

  const journal = createJournal(config.logFile);
  const engine = createSpeechEngine({
    subprocess: ctx.subprocess,
    logger,
    config,
    // 播报失败必须留痕：宿主日志不落盘，静默失败会让人以为一切正常。
    onError: (kind, detail) => journal.write(kind, detail),
  });

  /** @type {Map<string, object>} */
  const states = new Map();
  /** @type {Map<string, object>} */
  const sessions = new Map();
  const llm = ctx.get('llm');
  const agentDefaultModel = ctx.get('agentDefaultModel');
  let disposed = false;

  function stateFor(session) {
    const id = String(session.id);
    let state = states.get(id);
    if (state === undefined) {
      state = createSessionState(id);
      states.set(id, state);
    }
    sessions.set(id, session);
    state.session = session;
    return state;
  }

  function isNoise(session) {
    if (config.includeSubagents) return false;
    const header = session?.header;
    if (header === undefined || header === null) return false;
    return header.origin === 'subagent' || header.parentSession !== undefined;
  }

  /**
   * 解析这次摘要用哪个模型：显式配置 > 该会话自己的请求上下文 > 默认模型。
   * @param {object} session - 会话。
   * @returns {{provider: string, model: string}} 路由。
   */
  function routeFor(session) {
    if (config.summaryProvider !== '' && config.summaryModel !== '') {
      return { provider: config.summaryProvider, model: config.summaryModel };
    }
    let route = {};
    try {
      route = selectionOf(session?.requestContext?.());
    } catch { /* 忽略 */ }
    if (route.provider !== '' && route.model !== '') return route;
    try {
      route = selectionOf(agentDefaultModel?.currentSelection?.());
    } catch { /* 忽略 */ }
    return route;
  }

  /**
   * 真正出话：抽干缓冲 → 摘要 → 交给语音队列。
   * @param {object} state - 会话状态。
   * @param {object} boundary - 触发的边界。
   * @param {object} session - 会话。
   */
  async function flush(state, boundary, session) {
    if (disposed || state.disposed) return;
    state.inFlight = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('summary timeout')), config.llmTimeoutMs);
    try {
      const snapshot = drain(state);
      const route = routeFor(session);
      const text = await summarize({
        llm: config.useLlmSummary ? llm : undefined,
        provider: route.provider,
        model: route.model,
        logger,
        signal: controller.signal,
        maxChars: config.maxChars,
      }, snapshot, boundary.reason);

      // ⚠️ 这里以前是静默 return —— 判定过的边界就此人间蒸发，审计日志里查不到原因。
      //    2026-10-01 排查「判定了却没播」时，4 条边界全部无法归因，就是因为这两条路径不留痕。
      //    现在改成：**每个判定过的边界，最终必定留下 announce / dropped / pipeline-error 之一。**
      if (text === '' || disposed || state.disposed) {
        const why = disposed || state.disposed ? '插件已卸载或重载' : '摘要为空';
        journal.write('dropped', `${boundary.reason}\t${why}`);
        return;
      }
      state.lastAnnounceAt = Date.now();
      engine.speak(text, boundary.priority);
      journal.write('announce', `${boundary.reason}\t${text}`);
      if (config.logAnnouncements) {
        try { logger?.info('dsh-stage-speak: [%s] %s', boundary.reason, text); } catch { /* 忽略 */ }
      }
    } catch (error) {
      const detail = error?.message ?? String(error);
      journal.write('pipeline-error', `${boundary.reason}\t${detail}`);
      warn('播报流水线失败', detail);
    } finally {
      clearTimeout(timer);
      state.inFlight = false;
    }
  }

  /**
   * 排期一次播报：急事立刻走，普通事在 throttleMs 静默期后合并成一次。
   * @param {object} state - 会话状态。
   * @param {{reason: string, priority: number}} boundary - 边界。
   * @param {object} session - 会话。
   */
  function schedule(state, boundary, session) {
    const current = state.pendingBoundary;
    if (current === null || current === undefined || boundary.priority > current.priority) {
      state.pendingBoundary = boundary;
    } else {
      // 被已挂起的边界合并 —— 必须留痕。
      // 否则它和「判定后失败」在日志里长得一样（都只有 boundary 没有 announce），无法归因。
      journal.write('coalesced', `${boundary.reason}\t并入已挂起的 ${current.reason}`);
    }
    const pending = state.pendingBoundary;
    const high = pending.priority >= PRIORITY.high;

    // 边界可自带节流窗口（开工反馈要"第一时间"，用短窗口）
    const window = Number.isFinite(boundary.throttleMs) && boundary.throttleMs >= 0
      ? boundary.throttleMs
      : config.throttleMs;
    let delay = high ? 0 : window;
    if (!high) {
      // 尊重最小间隔：上一次播报太近就顺延。
      const sinceLast = Date.now() - state.lastAnnounceAt;
      if (state.lastAnnounceAt > 0 && sinceLast < config.minGapMs) {
        delay = Math.max(delay, config.minGapMs - sinceLast);
      }
    }

    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      const queued = state.pendingBoundary;
      state.pendingBoundary = null;
      if (queued === null || queued === undefined) return;
      void flush(state, queued, session);
    }, delay);
  }

  ctx.on('session/event', (session, event) => {
    try {
      if (disposed) return;
      if (session === undefined || event === undefined) return;
      if (isNoise(session)) return;
      const state = stateFor(session);
      if (state.disposed) return;
      const boundary = noteEvent(state, event, config);
      if (boundary === null) return;
      journal.write('boundary', `${boundary.reason}\tsession=${String(session.id)}`);
      schedule(state, boundary, session);
    } catch (error) {
      warn('事件处理失败', error?.message ?? error);
    }
  });

  ctx.on('session/disposed', (session) => {
    try {
      const id = String(session?.id);
      const state = states.get(id);
      if (state !== undefined) {
        state.disposed = true;
        if (state.timer !== null) clearTimeout(state.timer);
        states.delete(id);
      }
      sessions.delete(id);
    } catch { /* 忽略 */ }
  });

  // ── 静默心跳：唯一的时间触发 ────────────────────────────────────────────
  // 目的：工具调用期间若长时间没有任何播报，用户会以为卡住了。
  // 严格守卫：① 本轮必须仍在进行 ② 距上次播报超过 silenceHeartbeatMs
  //           ③ 期间**确实有活动**（有新工具调用、新事件，**或有调用正在飞**）——
  //              三样都没有就不报，否则助手真卡住时它会编造"正在努力工作"，比沉默更糟。
  //
  // ⚠️ 2026-10-01 修正：「在飞调用」必须算活动（见 activity.js 的 inFlightCalls）。
  //    阻塞型调用（sleep / 长构建 / 大文件下载）飞行期间**零会话事件**，而前一次播报的
  //    drain() 又会把它在缓冲里的唯一痕迹抽走 → 单看缓冲必然判"没活动"。
  //    实测后果：便携投影仪选型会话静默 187 秒，任务其实一直在推进。
  if (config.silenceHeartbeatMs > 0) {
    const tick = Math.max(200, Math.min(15000, Math.floor(config.silenceHeartbeatMs / 2)));
    ctx.effect(() => {
      const timer = setInterval(() => {
        if (disposed) return;
        const now = Date.now();
        for (const state of states.values()) {
          try {
            if (state.disposed || !state.turnActive) continue;
            // 已有排期或正在摘要，不重复触发
            if (state.timer !== null || state.inFlight === true) continue;
            const baseline = state.lastAnnounceAt > 0 ? state.lastAnnounceAt : state.turnStartedAt;
            if (now - baseline < config.silenceHeartbeatMs) continue;
            // 没有活动就不报 —— 但缓冲为空≠没活动：有调用在飞就是确实在干活
            const buffered = state.entries.length > 0 || state.toolCallsSinceAnnounce > 0;
            const pending = Array.isArray(state.inFlightCalls) && state.inFlightCalls.length > 0;
            if (!buffered && !pending) continue;
            if (!buffered) {
              // 缓冲已被上一次播报抽干：补一条如实描述，否则摘要只能对着空快照说废话。
              // 只陈述"正在跑什么、等了多久"，不编造进展。
              const line = pendingWorkLine(state, now);
              if (line !== '') state.entries.push({ kind: 'tool', text: line });
            }
            journal.write('boundary', `progress-heartbeat\tsession=${String(state.id)}`);
            schedule(state, { reason: 'progress-heartbeat', priority: PRIORITY.low }, state.session);
          } catch (error) {
            warn('心跳检查失败', error?.message ?? error);
          }
        }
      }, tick);
      return () => clearInterval(timer);
    }, 'dsh-stage-speak.heartbeat');
  }

  // 插件卸载时：清掉所有定时器与正在朗读的进程。
  ctx.effect(() => () => {
    disposed = true;
    for (const state of states.values()) {
      state.disposed = true;
      if (state.timer !== null) clearTimeout(state.timer);
    }
    states.clear();
    sessions.clear();
    engine.dispose();
  }, 'dsh-stage-speak.teardown');

  journal.write('ready', [
    `pid=${process.pid}`,
    `platform=${process.platform}`,
    `dsh=${String(ctx.get('dshVersion') ?? 'n/a')}`,
    `llm=${llm === undefined ? 'off' : 'on'}`,
    `voice=${config.voice === '' ? '(system default)' : config.voice}`,
  ].join('\t'));

  try {
    logger?.info(
      'dsh-stage-speak: 已就绪 (turnEnd=%s todo=%s approval=%s stageToolCalls=%d llm=%s)',
      String(config.announceTurnEnd),
      String(config.announceTodoCompleted),
      String(config.announceApprovals),
      config.stageToolCalls,
      llm === undefined ? 'off' : 'on',
    );
  } catch { /* 忽略 */ }
}
