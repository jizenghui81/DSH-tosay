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
import { PRIORITY, createSessionState, drain, noteEvent, pendingWorkLine, waitingLine } from './activity.js';
import { summarizeDetailed } from './summarize.js';
import { createSpeechEngine } from './engine.js';
import { createAudioCore } from './audio-core.js';
import { createDuplex } from './duplex.js';
import { createJournal } from './journal.js';

/** 插件名，同时是 Loader 行 id 与设置命名空间。 */
export const name = 'dsh-stage-speak';

/**
 * 硬依赖只有子进程（要调系统语音引擎）。
 * llm 走 ctx.get() 可选获取：没有摘要模型时自动退化成规则摘要，而不是加载失败。
 *
 * ⚠️ **`speechToText` / `agents` 刻意不写在这里**（V1.8.0 的取舍，别顺手改回去）：
 *   cordis 的 `inject` **没有 optional 语义** —— `Fiber._refresh()` 对 inject 里每一个名字
 *   都要求 store 里有实现，缺一个就把 epoch 置 INACTIVE、**整个插件永不激活**。
 *   即：把 experimental 的 `speechToText` 写进 inject，等于让"没装语音 bundle 的机器"
 *   连默认档 `off` 的播报都一起失去 —— 双工只是增强，不能拿主功能做抵押。
 *   官方给"不带 inject 要求读服务"的入口就是 `ctx.get(name)`（见 cordis 源码注释
 *   "Read a service from the store without the inject requirement"）。
 *   所以：下面全程用 `ctx.get(...)`，缺服务时只 warn + 留痕，播报照旧。
 */
export const inject = ['subprocess'];

/** 配置契约。带 volatile() 的字段会被投影到 DSH 的设置页。 */
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).volatile(),
  /**
   * 双工档位（面板上的三档开关）。
   *
   * 这是**面向用户的总控**，与下面一堆细粒度开关并存。**四档语义各自独立**：
   *   `off`   = **原始**：照旧播报，行为与 v1.5.1 完全一致；**不启用麦克风、不做任何双工**
   *   `half`  = 半双工：只做 VAD，你一开口就暂停播报让路；输入仍走你自己的输入法
   *   `full`  = 全双工：VAD + 本地识别 + 自动注入（**已接线**，见下面 `duplex*` 字段）
   *   `mute`  = 静音：完全停用（等价于 `enabled: false`，不注册任何监听）
   *
   * ⚠️ 为什么把"原始"单列，而不是让 `off` 兼作关闭：这两件事根本不同 ——
   *    "照旧念" 与 "别念了"。混成一个档，用户想回到原始行为时只能去翻总开关。
   *
   * ⚠️ **`half` 已接线**（V1.7.0）：配合下面四个 `audioCore*` / `bargeIn*` 字段启用音频内核，
   *    你开口时播报立刻停下让路（barge-in）。内核不可用时自动退回原路径，播报不受影响。
   * ⚠️ **`full` 已接线**（V1.8.0）：在半双工之上，内核把每句话写成 WAV（`ASR_ENABLED=1`
   *    + `ASR_UTTERANCE_DIR`），`lib/duplex.js` 读文件 → 本机 SenseVoice 识别 →
   *    识别文本作为**用户消息**插进当前回合（`duplexInjectMode`）。
   *    `speechToText` / `agents` 任一不可用 → 只 warn，双工通路关闭，**播报照旧**。
   */
  mode: Schema.union(['off', 'half', 'full', 'mute']).default('off').volatile(),
  // —— 播报什么 ——
  announceTurnEnd: Schema.boolean().default(true).volatile(),
  // 零工具调用的纯聊天轮次：不念摘要，但仍播一句确定性收束语（结束信号不能省）
  announceTurnEndOnChat: Schema.boolean().default(true).volatile(),
  // 开工反馈：接到新任务的第一时间给"收到 + 思路"的口头确认
  announceKickoff: Schema.boolean().default(true).volatile(),
  kickoffThrottleMs: Schema.number().default(400).volatile(),
  kickoffMinTaskChars: Schema.number().default(4).volatile(),
  // 静默心跳：本轮进行中、且超过这么久没播报过，就报一次进展（0 = 关闭）
  silenceHeartbeatMs: Schema.number().default(30000).volatile(),
  /**
   * 「等模型返回」类心跳的续报下限（毫秒）。
   *
   * 节奏方案「丁」：**不新增用户可见的旋钮** —— 本项刻意不加 `.volatile()`，不出现在设置页。
   * 默认 60 秒：等模型时的话术只差秒数（"还在等模型返回，已经 1 分 32 秒"），
   * 30 秒一次会显得唠叨。工具在飞、或缓冲里有真实内容时**不受**此限。
   * 置 0 = 关闭该下限（回到与工具心跳同频）。
   */
  modelWaitMinGapMs: Schema.number().default(60000),
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
  /**
   * **备用音色**（方案 A：音色绑定会话）。留空 = 关闭该功能，行为与以前完全一致。
   *
   * 多会话并行时两边都播报，同音色分不清是哪一边。规则：**第一个活跃会话用主音色**，
   * 此后新开的会话拿这个备用音色；主音色会话退场后，下一个新会话重新拿回主音色。
   *
   * **可填多个**（逗号分隔，如 `A, B, C`）：够用就不会撞音色；只填一个时 ≥3 会话会重复。
   *
   * ⚠️ 只在"拿到备用音色的会话"上生效：经 `MMX_VOICE` 下发（包内 MiniMax wrapper 的最高优先级）。
   *    主音色会话**完全不设置**该变量，继续走 `~/.dsh/tools/minimax-voice.txt` —— 零回归。
   *    也正因如此，这里不能填 macOS `say` 的音色名（那会让云端引擎报错回退），要填 MiniMax 的 voice_id。
   */
  voiceAlt: Schema.string().default('').volatile(),
  rate: Schema.number().default(0).volatile(),
  volume: Schema.number().default(100).volatile(),
  engine: Schema.string().default('').volatile(),
  // —— 半双工 barge-in（音频内核）——
  /**
   * 音频内核路径（`engine/audio-core`，Swift 编译产物）。
   *
   * 约定与 `engine` 一致：`./` `../` 开头相对**插件包根**解析（随包分发、不带绝对路径），
   * 其余原样。默认 `./engine/audio-core`。
   *
   * ⚠️ 内核要能双向通信（stdin/stdout 各一行 JSON），所以只在 `mode: 'half'` 下启用；
   *    内核不存在 / 启不来 → 只 warn，播报退回 wrapper 自播（绝不因此变哑）。
   */
  audioCorePath: Schema.string().default('./engine/audio-core').volatile(),
  /** barge-in 总开关：`mode: 'half'` 且本项不为 false 时才启用音频内核。 */
  bargeInEnabled: Schema.boolean().default(true).volatile(),
  /** 判定"你在说话"需要高出底噪多少 dB（内核 `VAD_OVER_DB`）。 */
  bargeInOverDb: Schema.number().default(9).volatile(),
  /**
   * **播报期间**判定"你在说话"的门限（高出底噪多少 dB，内核 `VAD_OVER_DB_PLAYING`）。
   *
   * 为什么单独一项：外放时自己的声音会漏回麦克风（实测抬升约 5.5 dB），播放期若沿用
   * 安静时的门限就会"自己把自己打断"。用更严的门限挡在门外 —— 依据是你插话时离麦克风
   * 很近，电平必然远高于回声。
   */
  bargeInOverDbPlaying: Schema.number().default(14).volatile(),
  /** 判定"说完了"需要连续静音多久（毫秒）→ 换算成内核的释放帧数。 */
  bargeInReleaseMs: Schema.number().default(600).volatile(),
  // —— 全双工（`mode: 'full'`：本地识别 + 注入会话）——
  /** 全双工总开关：`mode: 'full'` 且本项不为 false 时才启用「分句落盘 → 识别 → 注入」。 */
  duplexEnabled: Schema.boolean().default(true).volatile(),
  /**
   * 识别语言提示（本机 SenseVoice 的白名单：`auto` `zh` `en` `yue` `ja` `ko`）。
   *
   * ⚠️ 传白名单外的值**会在 `resolve()` 直接抛**「does not support language」——
   *    duplex.js 会接住并留痕，但那样等于每次都识别失败，所以别乱填。
   */
  duplexLanguage: Schema.string().default('zh').volatile(),
  /**
   * 防自注入兜底开关（默认开）。
   *
   * 关掉会发生什么（真机实测过）：助手播报的内容被麦克风收回去、又被识别成"用户说的话"，
   * **重复注入会话** —— 日志时间线：07:03:47 播报 → 07:03:50 注入同一句。
   * 开着时有两层防御：内核的播放冷却窗（窗内维持严格门限）+ 这里与"最近念过的文本"做相似度比对。
   */
  duplexEchoGuard: Schema.boolean().default(true).volatile(),
  /**
   * 识别文本怎么进会话：
   *   `steer`    = 插进当前回合的下一个 step 边界（**不打断**正在飞的模型请求）——默认
   *   `followup` = 作为新的一轮排在后面（当前回合结束后才处理）
   */
  duplexInjectMode: Schema.union(['steer', 'followup']).default('steer').volatile(),
  /**
   * 档位看门狗节拍（毫秒）。
   *
   * ⚠️ 为什么需要它：面板保存配置走的是 cordis 的 **volatile 原地热更新**（只改
   * `fiber.config` 的活访问器，不重挂载插件、不重跑 `apply`），而且没有"配置已变更"的
   * 通知事件可订阅 —— 所以插件必须自己低频比对活配置，才能让拨档位当场生效、不必重启宿主。
   *
   * ⚠️ 刻意**不加 `.volatile()`**（同 `modelWaitMinGapMs` 的先例）：这是内部节拍，不是
   * 用户要动的旋钮，不出现在设置页。置 0 = 关闭看门狗（此时只剩 `loader/volatile-update`
   * 事件那条触发路径）。
   */
  modeWatchMs: Schema.number().default(1500),
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
  mode: 'off',
  announceTurnEnd: true,
  announceTurnEndOnChat: true,
  announceKickoff: true,
  kickoffThrottleMs: 400,
  kickoffMinTaskChars: 4,
  silenceHeartbeatMs: 30000,
  modelWaitMinGapMs: 60000,
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
  voiceAlt: '',
  rate: 0,
  volume: 100,
  engine: '',
  audioCorePath: './engine/audio-core',
  bargeInEnabled: true,
  bargeInOverDb: 9,
  bargeInOverDbPlaying: 14,
  bargeInReleaseMs: 600,
  duplexEnabled: true,
  duplexLanguage: 'zh',
  duplexInjectMode: 'steer',
  duplexEchoGuard: true,
  modeWatchMs: 1500,
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
 * 拼出真正要朗读的文本：**确定性信号前缀在前，摘要跟在后面**。
 * 信号有两类：turn-end 的收束语、以及 approval / user-question 的断点提示。
 *
 * ⚠️ 收束语必须放句首，这是结构性要求而非风格偏好：`truncateForSpeech`（clean.js）
 *    只保留前缀窗口（`text.slice(0, maxChars)` 再回退到最后一个句末），
 *    句尾内容超长会被整段截掉 —— 放句尾的收束语会在长摘要上随机消失。
 *
 * 空值语义：两边都空 → 返回空串（调用方据此走 dropped，保持通道契约）；
 * 只有一边有 → 返回那一边（**摘要为空时收束语仍然出声**，结束信号不能被吞）。
 *
 * @param {unknown} signal - 确定性信号前缀（收束语 / 断点提示，可为空串）。
 * @param {unknown} text - 摘要文本（可为空串）。
 * @returns {string} 待朗读文本。
 */
export function composeAnnouncement(signal, text) {
  const c = typeof signal === 'string' ? signal : '';
  const t = typeof text === 'string' ? text : '';
  if (c === '') return t;
  if (t === '') return c;
  // 摘要自己已经带了这句收束语 → 不再前置，否则同一句话会连听两遍。
  // ⚠️ 实测（2026-10-01 06:53）：规则兜底给出的正是「这一轮结束了。」，
  //    与收束语拼成「这一轮结束了。这一轮结束了。」；模型也可能自行写出这句。
  if (t.startsWith(c)) return t;
  return `${c}${t}`;
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
  out.modelWaitMinGapMs = Math.max(0, out.modelWaitMinGapMs);
  out.minGapMs = Math.max(0, out.minGapMs);
  out.stageToolCalls = Math.max(0, Math.round(out.stageToolCalls));
  out.turnEndMinToolCalls = Math.max(0, Math.round(out.turnEndMinToolCalls));
  out.maxChars = Math.max(0, Math.round(out.maxChars));
  out.llmTimeoutMs = Math.max(0, out.llmTimeoutMs);
  out.rate = Math.max(0, out.rate);
  out.volume = Math.max(0, Math.min(100, out.volume));
  out.bargeInOverDb = Math.max(0, out.bargeInOverDb);
  out.bargeInOverDbPlaying = Math.max(0, out.bargeInOverDbPlaying);
  out.bargeInReleaseMs = Math.max(0, out.bargeInReleaseMs);
  // 看门狗节拍：0 = 关闭；非 0 时给个 50ms 下限，免得有人填 1 变成热循环。
  out.modeWatchMs = out.modeWatchMs <= 0 ? 0 : Math.max(50, out.modeWatchMs);
  // 全双工：语言留空回落 `zh`（provider 白名单外的值会让 resolve() 抛，见字段注释）；
  // 注入方式只认 `followup`，其余（含拼错、空串）一律按默认的 `steer`。
  out.duplexLanguage = out.duplexLanguage.trim() === '' ? 'zh' : out.duplexLanguage.trim();
  out.duplexInjectMode = out.duplexInjectMode === 'followup' ? 'followup' : 'steer';
  // 路径类字段允许写 `~/...`：包内默认配置要跨机器可用，不能写死绝对路径。
  for (const key of ['logFile', 'engine', 'cwd', 'audioCorePath']) out[key] = expandHome(out[key]);
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

  // 彻底停用只有两种入口：关总开关，或把档位拨到 `mute`。
  // ⚠️ `mode: 'off'` 是**原始档**——照旧播报、只是不开双工，**不在这里返回**。
  if (!config.enabled || config.mode === 'mute') {
    try { logger?.info('dsh-stage-speak: 已禁用，不注册任何监听'); } catch { /* 忽略 */ }
    return;
  }

  const journal = createJournal(config.logFile);

  /**
   * 最近念过的文本（环形缓冲），供全双工做"回声比对"。
   *
   * 为什么插件侧记而不是读 journal：journal 是落盘文本、还要解析，而这里每念一句就地记一笔最省事。
   * 只留最近一批：比对窗口本就只有 20 秒，留多了反而容易误杀用户复述较早内容。
   */
  const recentSpeech = [];
  const RECENT_SPEECH_LIMIT = 32;
  /**
   * 记一句刚念出去的文本。
   * @param {string} text - 实际交给引擎朗读的文本。
   */
  const noteSpeech = (text) => {
    const value = typeof text === 'string' ? text.trim() : '';
    if (value === '') return;
    recentSpeech.push({ text: value, at: Date.now() });
    if (recentSpeech.length > RECENT_SPEECH_LIMIT) recentSpeech.splice(0, recentSpeech.length - RECENT_SPEECH_LIMIT);
  };

  // ── 通路（音频内核 + 全双工 + 引擎）的建立/拆除：**必须可重入** ──────────────
  //
  // 为什么（真机缺陷，2026-10-02）：面板保存配置走的**不是**插件重挂载，而是
  // `cordis-plugin-loader._commitVolatile()` 的 volatile 快路径 —— 它把新值
  // `updateVolatile(ref, source)` **原地写进 `fiber.config` 的活访问器**，随后 `return true`
  // → `pending = []` → **不重挂载、apply 不再跑**（源码逐字读过）。
  // 于是"apply 时读一次档位就缓存"= 用户拨档位永远不生效、必须重启宿主。
  // 现在：判定函数每次都读**活配置**，档位键变化就拆掉旧通路、按新档位重建。
  //
  // 触发来源两条（同一套幂等差分，重复触发无害）：
  //   1) `loader/volatile-update` —— 上面那条快路径会发这个事件（fiber 过滤后送得到本插件），即时；
  //   2) 低频看门狗 —— 兜底（事件拿不到、或将来 DSH 改了内部行为时仍然生效）。
  // 两条都不工作也不影响播报：最坏退化成"启动时判定一次"（= 修复前的行为）。

  /**
   * 读**活配置**：面板保存改的是 `ctx.fiber.config` 这个活对象。
   * 取不到（非 Loader 挂载 / 没有 fiber / 代理抛错）→ 退回 `apply` 时的原始入参快照。
   * @returns {unknown} 原始配置源（可能是访问器对象；`resolveConfig` 两种形状都吃）。
   */
  function liveConfigSource() {
    try {
      const live = ctx.fiber?.config;
      if (live !== null && live !== undefined && typeof live === 'object') return live;
    } catch { /* 取活配置失败不改行为：回落启动快照 */ }
    return rawConfig;
  }

  /**
   * 读一个可选服务。
   *
   * ⚠️ `agents` / `speechToText` **不用静态 inject**：见文件头 `export const inject` 的注释
   * （cordis 的 inject 无 optional 语义，缺一个服务整插件不激活）。
   * @param {string} serviceName - 服务名。
   * @returns {unknown} 服务对象；不可用时为 undefined。
   */
  function readService(serviceName) {
    try {
      return ctx.get(serviceName);
    } catch (error) {
      warn(`读取服务 ${serviceName} 失败`, error?.message ?? error);
      return undefined;
    }
  }

  /** @type {object|null} 音频内核客户端（半双工/全双工共用）；null = 本档不用内核。 */
  let audioCore = null;
  /** @type {object|null} 全双工通路；null = 本档没启用或依赖缺失。 */
  let duplex = null;
  /** @type {object|null} 播报引擎。**通路变化时必须重建** —— engine 在构造时快照了 audioCore。 */
  let engine = null;

  /** 引擎的事件回调（重建时复用同一份）。 */
  const engineHooks = {
    // 内核报 `voice` 时引擎**自己**会 interrupt('barge-in')；这里只留痕。
    // 刻意不在这里再调一次 interrupt —— 那会让打断计数翻倍（同一句话记两次）。
    onBargeIn: (event) => journal.write('barge-in', `level=${event?.level ?? 'n/a'}`),
    // 播报失败必须留痕：宿主日志不落盘，静默失败会让人以为一切正常。
    onError: (kind, detail) => journal.write(kind, detail),
  };

  /**
   * 从**当前 config** 算出通路状态（纯函数，可反复调用）。
   * @returns {{mode: string, bargeIn: boolean, duplex: boolean}} 通路状态。
   */
  function pathState() {
    // 半双工 barge-in：`half` / `full` 且没被显式关掉时才启用音频内核。
    // 内核起不来（缺二进制 / spawn 抛错 / 没有双向管道）→ createAudioCore 返回 null，
    // 播报退回 wrapper 自播：barge-in 是增强，绝不能因为增强失败把播报搞哑。
    const bargeIn = (config.mode === 'half' || config.mode === 'full') && config.bargeInEnabled !== false;
    // 全双工：在 `full` 档之上，加"分句落盘 → 本地识别 → 注入会话"。
    // 三段任一缺失都只降级、不抛：没有内核 → 没有分句；没有识别服务 → 没有文本；
    // 没有 agents → 没有可注入的对象。三者都不影响播报。
    const wantDuplex = config.mode === 'full' && config.duplexEnabled !== false;
    return { mode: config.mode, bargeIn, duplex: wantDuplex };
  }

  /** 通路状态 → 可比较的字符串（差分与 journal 都用它）。 */
  const pathKeyOf = (state) => `${state.mode}|kernel=${state.bargeIn ? 1 : 0}|duplex=${state.duplex ? 1 : 0}`;
  /** 只影响 duplex 自身行为（不决定通路是否存在）的键。 */
  const duplexParamsKey = () => `${config.duplexLanguage}|${config.duplexInjectMode}`;
  /** 上次生效的通路状态 / duplex 参数（差分基准）。 */
  let currentPathKey = '';
  let currentDuplexParams = '';

  /**
   * 建一个全双工通路（依赖缺失时给出原因，绝不抛）。
   * @returns {{duplex: object|null, why: string}} 通路对象与缺失原因。
   */
  function createDuplexOrNull() {
    const agents = readService('agents');
    const speechToText = readService('speechToText');
    if (!pathState().bargeIn) {
      return { duplex: null, why: 'bargeInEnabled=false（全双工依赖音频内核分句）' };
    }
    if (speechToText === undefined || speechToText === null) {
      return { duplex: null, why: '没有 speechToText 服务（本机未挂语音 bundle）' };
    }
    if (agents === undefined || agents === null) {
      return { duplex: null, why: '没有 agents 服务' };
    }
    return {
      why: '',
      duplex: createDuplex({
        speechToText,
        logger,
        journal,
        config,
        // 目录在 audioCore 建好后才确定，用取值函数避免时序耦合。
        utteranceDir: '',
        // 防自注入第二层：拿"最近念过的文本"比对识别结果（见 lib/duplex.js）。
        recentSpeech: () => recentSpeech,
        resolveTarget: () => {
          const id = duplexTargetId;
          if (id === '' || !states.has(id)) return null;
          let agent;
          try { agent = agents.get(id); } catch { agent = undefined; }
          if (agent === undefined || agent === null) return null;
          return { sessionId: id, agent };
        },
      }),
    };
  }

  /** 按**当前 config** 建立整条通路（内核 + 全双工 + 引擎）。 */
  function buildPath() {
    const state = pathState();
    duplex = null;
    audioCore = null;

    if (state.duplex) {
      const built = createDuplexOrNull();
      duplex = built.duplex;
      if (duplex === null) {
        warn('全双工已关闭，播报不受影响', built.why);
        journal.write('duplex-unavailable', built.why);
      }
    }

    audioCore = state.bargeIn
      ? createAudioCore({
        subprocess: ctx.subprocess,
        logger,
        // 只有全双工真的可用时才让内核分句落盘；否则内核照旧只做 VAD（半双工语义）。
        config: duplex === null ? config : { ...config, asrEnabled: true },
      })
      : null;
    if (state.bargeIn && audioCore === null) {
      warn('音频内核不可用，barge-in 已关闭、播报走原路径', config.audioCorePath);
    }
    if (duplex !== null && audioCore === null) {
      // 内核起不来 = 拿不到 utterance-file = 全双工名存实亡。留痕，别让它静默失效。
      duplex = null;
      const why = '音频内核不可用（拿不到分句事件）';
      warn('全双工已关闭，播报不受影响', why);
      journal.write('duplex-unavailable', why);
    }

    // ⚠️ 监听挂在**这一个 audioCore 实例**上：实例一换，旧监听随旧进程一起消失，
    //    所以重建不会重复挂（重复挂的后果是同一句被处理两次）。
    //    回调里读的是**当前** `duplex`：只重建 duplex（改语言/注入方式）时无需重挂监听。
    if (audioCore !== null) {
      audioCore.on('utterance-file', (event) => {
        const target = duplex;
        if (target === null) return;
        // 内核事件回调里绝不能抛；handle 内部全兜住，再套一层是防"未来改坏了"。
        try {
          void target.handle({ ...event, dir: audioCore.utteranceDir });
        } catch (error) {
          warn('全双工事件处理失败', error?.message ?? error);
        }
      });
    }

    engine = createSpeechEngine({ subprocess: ctx.subprocess, logger, config, audioCore, ...engineHooks });
    currentPathKey = pathKeyOf(state);
    currentDuplexParams = duplexParamsKey();
  }

  /**
   * 拆掉整条通路。
   *
   * 顺序有讲究：先 duplex（中止在飞识别、不再碰内核）→ 再内核（quit + 清临时录音目录）
   * → 最后引擎（停播报；它内部也会 dispose 一次 audioCore，是幂等的）。
   * 每一步各自兜错：拆不干净也只是留个进程，绝不能让异常冒到调用方。
   */
  function teardownPath() {
    try { duplex?.dispose(); } catch (error) { warn('关闭全双工通路失败', error?.message ?? error); }
    duplex = null;
    try { audioCore?.dispose(); } catch (error) { warn('关闭音频内核失败', error?.message ?? error); }
    audioCore = null;
    try { engine?.dispose(); } catch (error) { warn('关闭播报引擎失败', error?.message ?? error); }
    engine = null;
  }

  /**
   * 只重建 duplex（识别语言 / 注入方式变了）。
   *
   * 为什么不整条重建：内核重启要重新起麦克风 + 重新校准（约 2–3.5 秒），
   * 只为改一个语言就把它推倒重来太亏。内核不动，只换"读文件 → 识别 → 注入"这半边。
   */
  function rebuildDuplexOnly() {
    try { duplex?.dispose(); } catch (error) { warn('关闭全双工通路失败', error?.message ?? error); }
    duplex = null;
    if (!pathState().duplex || audioCore === null) return;
    const built = createDuplexOrNull();
    duplex = built.duplex;
    if (duplex === null) journal.write('duplex-unavailable', built.why);
  }

  /**
   * 差分刷新：读活配置 → 归一化 → **只在关键键变化时**重建。
   * @param {string} trigger - 触发来源（写进 journal）：`watchdog` / `volatile-update` / `startup`。
   * @returns {boolean} 是否真的重建了通路。
   */
  function refreshPath(trigger) {
    // 已卸载就绝不再建通路（卸载后还起内核 = 漏一个占麦克风的进程）。
    if (disposed) return false;
    let next;
    try {
      next = resolveConfig(liveConfigSource());
    } catch (error) {
      warn('读取活配置失败，本次不刷新', error?.message ?? error);
      return false;
    }
    // 就地更新：flush / schedule / 心跳等闭包读到的都是新值 —— 这也是面板"改配置热生效"的兑现。
    Object.assign(config, next);

    const state = pathState();
    const key = pathKeyOf(state);
    if (key !== currentPathKey) {
      const from = currentPathKey;
      journal.write('duplex-mode-changed', `from=${from} to=${key} trigger=${trigger}`);
      teardownPath();
      buildPath();
      return true;
    }
    // 通路存在与否没变，但 duplex 自己的参数变了 → 只换那半边。
    if (duplexParamsKey() !== currentDuplexParams) {
      currentDuplexParams = duplexParamsKey();
      journal.write('duplex-params-changed',
        `language=${config.duplexLanguage} inject=${config.duplexInjectMode} trigger=${trigger}`);
      rebuildDuplexOnly();
      return true;
    }
    return false;
  }

  // 首次建立（与修复前逐字等价：同样的顺序、同样的告警与留痕）。
  buildPath();

  /** @type {Map<string, object>} */
  const states = new Map();
  /** @type {Map<string, object>} */
  const sessions = new Map();
  /**
   * 全双工把"你说的话"注入给谁：**最近有活动的那个会话**。
   *
   * 音频内核是插件级单例（一个麦克风），而会话可以有多个；用户在对着"正在播报/刚播报过"
   * 的那条会话说话。所以取最近一次产生会话事件的那条 —— 没有更可靠的信号可用
   * （内核不认识会话，它的 VAD 只认识电平）。
   */
  let duplexTargetId = '';
  const llm = ctx.get('llm');
  const agentDefaultModel = ctx.get('agentDefaultModel');
  let disposed = false;

  /**
   * 解析备用音色清单：**逗号分隔可填多个**（单个值 = 老行为，完全兼容）。
   *
   * @returns {string[]} 备用音色列表；空数组 = 该功能关闭。
   */
  function altVoices() {
    return config.voiceAlt
      .split(',')
      .map((voice) => voice.trim())
      .filter((voice) => voice !== '');
  }

  /**
   * 方案 A：把音色绑定到"会话"这个身份上。
   *
   * 判据是**当前活跃会话**而非计数器：第一个活跃会话拿主音色（返回空串 = 不覆盖），
   * 其余会话按顺序拿备用音色。主音色会话退场后，下一个新会话重新拿回主音色 ——
   * 这样单会话用户永远听到的是同一个声音，不会因为开了又关而漂移。
   *
   * ⚠️ 备用音色**可以有多个**（`voiceAlt: 'A, B, C'`）。只填一个时，≥3 个会话会撞音色、
   *    分不清谁在说；填够就不撞。用满之后的第 N 个会话回绕复用（不再有更好的办法，
   *    但也只是音色重复，不影响功能）。
   *
   * @returns {string} 该会话的音色覆盖；空串 = 跟随配置（主音色）。
   */
  function pickSessionVoice() {
    const pool = altVoices();
    if (pool.length === 0) return '';
    // 收集"当前已被别的活跃会话占用的备用音色"
    const taken = new Set();
    for (const other of states.values()) {
      if (other.disposed === true) continue;
      const voice = other.voiceOverride;
      if (voice !== '' && voice !== undefined) taken.add(voice);
    }
    // 主音色还空着 → 新会话优先拿主音色（单会话用户永远同一个声音）
    const mainTaken = [...states.values()].some((other) => other.disposed !== true && (other.voiceOverride === '' || other.voiceOverride === undefined));
    if (!mainTaken) return '';
    // 主音色被占 → 挑一个还没被占用的备用音色；都用满了就按会话数回绕
    for (const voice of pool) if (!taken.has(voice)) return voice;
    return pool[taken.size % pool.length];
  }

  function stateFor(session) {
    const id = String(session.id);
    let state = states.get(id);
    if (state === undefined) {
      state = createSessionState(id);
      // ⚠️ 必须在 states.set 之前分配：分配时"自己"还不算活跃会话
      state.voiceOverride = pickSessionVoice();
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
      const signal = typeof boundary.signal === 'string' ? boundary.signal : '';

      // 纯聊天轮次（零工具调用）：没有可汇报的操作，直接念收束语。
      // 不调模型 —— 既省一次往返，也免得听一句"还在处理中"式的废话。
      // 关键：**结束信号照给**，这是用户 2026-10-01 明确要求的"每轮都要有结束信号"。
      if (boundary.signalOnly === true && signal !== '') {
        state.lastAnnounceAt = Date.now();
        engine.speak(signal, boundary.priority, state.voiceOverride);
        noteSpeech(signal);
        journal.write('announce', `${boundary.reason}\t${signal}\tsignal-only`);
        return;
      }

      const route = routeFor(session);

      // 事实型播报（在飞调用 / 等模型返回）：**不调摘要模型**，直接念那条如实描述。
      // 只有在"快照里确实只有这一条"时才采用 —— 若期间又来了新事件，就照旧走摘要，
      // 免得把已经过时的一句话念出去（它可能已经等完了）。
      const fixed = typeof boundary.fixedText === 'string' ? boundary.fixedText : '';
      if (fixed !== '' && snapshot.lines.length === 1 && snapshot.lines[0] === fixed) {
        const spoken = composeAnnouncement(signal, fixed);
        state.lastAnnounceAt = Date.now();
        engine.speak(spoken, boundary.priority, state.voiceOverride);
        noteSpeech(spoken);
        journal.write('announce', `${boundary.reason}\t${spoken}\tfact`);
        return;
      }

      const { text, source } = await summarizeDetailed({
        llm: config.useLlmSummary ? llm : undefined,
        provider: route.provider,
        model: route.model,
        logger,
        signal: controller.signal,
        maxChars: config.maxChars,
      }, snapshot, boundary.reason);

      // 收束语在**摘要之外**拼接：文本由代码写死、不经过模型，因此永远不会漂移或丢失。
      // 摘要为空时收束语仍在 → 结束信号不会被"摘要失败"吞掉。
      const spoken = composeAnnouncement(signal, text);

      // ⚠️ 这里以前是静默 return —— 判定过的边界就此人间蒸发，审计日志里查不到原因。
      //    2026-10-01 排查「判定了却没播」时，4 条边界全部无法归因，就是因为这两条路径不留痕。
      //    现在改成：**每个判定过的边界，最终必定留下 announce / dropped / pipeline-error 之一。**
      if (spoken === '' || disposed || state.disposed) {
        const why = disposed || state.disposed
          ? '插件已卸载或重载'
          : '摘要为空且无收束语';
        journal.write('dropped', `${boundary.reason}\t${why}`);
        return;
      }
      state.lastAnnounceAt = Date.now();
      engine.speak(spoken, boundary.priority, state.voiceOverride);
      noteSpeech(spoken);
      // 第 4 字段 = 摘要来源（llm / rule）。排查时不必再靠猜。
      journal.write('announce', `${boundary.reason}\t${spoken}\t${source}`);
      if (config.logAnnouncements) {
        try { logger?.info('dsh-stage-speak: [%s] %s', boundary.reason, spoken); } catch { /* 忽略 */ }
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
      // 全双工的注入目标：最近有活动的那条会话（见 duplexTargetId 的注释）。
      duplexTargetId = String(session.id);
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
      // 目标会话没了：别再把识别文本往一个已销毁的会话上注入。
      if (duplexTargetId === id) duplexTargetId = '';
    } catch { /* 忽略 */ }
  });

  // ── 静默心跳：唯一的时间触发 ────────────────────────────────────────────
  // 目的：工具调用期间若长时间没有任何播报，用户会以为卡住了。
  // 严格守卫：① 本轮必须仍在进行 ② 距上次播报超过 silenceHeartbeatMs
  //           ③ 期间**确实有活动**（有新事件、**有调用在飞**、**或正在等模型返回**）——
  //              三样都没有就不报，否则助手真卡住时它会编造"正在努力工作"，比沉默更糟。
  //
  // ⚠️ 2026-10-01 修正一：「在飞调用」算活动（见 activity.js 的 inFlightCalls）。
  //    阻塞型调用（sleep / 长构建 / 大文件下载）飞行期间**零会话事件**，而前一次播报的
  //    drain() 又会把它在缓冲里的唯一痕迹抽走 → 单看缓冲必然判"没活动"。
  //    实测后果：便携投影仪选型会话静默 187 秒，任务其实一直在推进。
  //
  // ⚠️ 2026-10-01 修正二：「正在等模型返回」也算活动（见 activity.js 的 waitingKind）。
  //    官方定义 `step/start` = 一次模型调用 + 它请求的工具执行，所以从 step/start 到
  //    assistant/message 之间主机确定在一次模型调用中，而这整段**零事件**。
  //    重放 33 个真实会话：这类静默 44 段 / 5,258 秒（中位 92 秒、最长 323 秒）；
  //    而"完全没有任何状态可报"的真空段是 **0 段** —— 所以不做时间兜底式的"报平安"。
  if (config.silenceHeartbeatMs > 0) {
    const tick = Math.max(200, Math.min(15000, Math.floor(config.silenceHeartbeatMs / 2)));
    ctx.effect(() => {
      const timer = setInterval(() => {
        if (disposed) return;
        const now = Date.now();
        for (const state of states.values()) {
          try {
            if (state.disposed || !state.turnActive) continue;
            // 球在用户手上时一律不播：审批未决、或正在等用户回答问题。
            // 实测 17 次审批全部发生在有工具在飞时，只靠 inFlightCalls 会把"在等你"报成"在干活"。
            if (state.approvalPending === true) continue;
            if (Array.isArray(state.inFlightCalls)
              && state.inFlightCalls.some((call) => call?.name === 'ask_user_question')) continue;
            // 已有排期或正在摘要，不重复触发
            if (state.timer !== null || state.inFlight === true) continue;
            const baseline = state.lastAnnounceAt > 0 ? state.lastAnnounceAt : state.turnStartedAt;
            if (now - baseline < config.silenceHeartbeatMs) continue;
            // 三样都空才真的没活动
            const buffered = state.entries.length > 0 || state.toolCallsSinceAnnounce > 0;
            const pendingTool = Array.isArray(state.inFlightCalls) && state.inFlightCalls.length > 0;
            const waiting = typeof state.waitingKind === 'string' && state.waitingKind !== ''
              && Number(state.waitingSince) > 0;
            if (!buffered && !pendingTool && !waiting) continue;
            // 内容完全来自"等模型"这一条事实时，续报受 60 秒下限约束（节奏方案「丁」）：
            // 这类话术只差秒数，30 秒一次会显得唠叨；有真实缓冲内容时不受此限。
            const factOnly = !buffered && !pendingTool && waiting;
            if (factOnly && state.lastWaitingAnnounceAt > 0
              && now - state.lastWaitingAnnounceAt < config.modelWaitMinGapMs) continue;
            let fixedText = '';
            if (!buffered) {
              // ⚠️ 事实本身也得"够有料"才值得开口 —— 消息内容决定触发，不能只看静默时长。
              //    实测（2026-10-01 07:15，重启后的首次线上验证）：一次久静默之后紧接着
              //    新的模型调用，会念出「还在等模型返回，已经 4 秒。」—— 真话，但毫无信息量。
              //    所以要求这条事实自己的时长也达到 silenceHeartbeatMs。
              const factAge = pendingTool
                ? now - (Number(state.inFlightCalls[0]?.at) || now)
                : now - (Number(state.waitingSince) || now);
              if (factAge < config.silenceHeartbeatMs) continue;
              // 缓冲已被上一次播报抽干：补一条如实描述，否则摘要只能对着空快照说废话。
              // 只陈述"正在跑什么/在等什么、已经多久"，不编造进展。
              fixedText = pendingTool ? pendingWorkLine(state, now) : waitingLine(state, now);
              if (fixedText === '') continue;
              state.entries.push({ kind: 'tool', text: fixedText });
            }
            journal.write('boundary', `progress-heartbeat\tsession=${String(state.id)}`);
            schedule(state, {
              reason: 'progress-heartbeat',
              priority: PRIORITY.low,
              // 事实型播报（在飞/等模型）不走摘要模型：零编造风险、零额外往返。
              // flush 只在"快照内容确实只有这一条"时采用它，否则照旧走摘要。
              fixedText,
            }, state.session);
            if (factOnly) state.lastWaitingAnnounceAt = now;
          } catch (error) {
            warn('心跳检查失败', error?.message ?? error);
          }
        }
      }, tick);
      return () => clearInterval(timer);
    }, 'dsh-stage-speak.heartbeat');
  }

  // ── 档位看门狗：配置是**原地热更新**，只能自己发现变化 ──────────────────────
  // 为什么需要：见上面"通路必须可重入"的注释 —— volatile 快路径不重挂载插件。
  // 只在影响通路的键变化时才动（差分在 refreshPath 里做），平时一次属性比较而已。
  // `modeWatchMs` 有意**不做成面板字段**（同 `modelWaitMinGapMs` 的先例）：它是内部节拍，
  // 不是用户要调的旋钮；置 0 = 关闭看门狗（仍可被 `loader/volatile-update` 触发）。
  if (config.modeWatchMs > 0) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        // 与心跳同样的守卫：已经卸载就绝不重建通路（否则会漏一个没人管的内核进程）。
        if (disposed) return;
        try {
          refreshPath('watchdog');
        } catch (error) {
          // 看门狗失败绝不能影响会话：记一笔，下一拍继续试。
          warn('档位看门狗失败', error?.message ?? error);
        }
      }, config.modeWatchMs);
      return () => clearInterval(timer);
    }, 'dsh-stage-speak.mode-watchdog');
  }

  // 那条 volatile 快路径自己会发 `loader/volatile-update`（按 fiber 过滤后送得到本插件），
  // 收到就地比对 —— 比等下一次轮询即时。与看门狗共用同一套幂等差分，重复触发无害。
  ctx.on('loader/volatile-update', () => {
    if (disposed) return;
    try {
      refreshPath('volatile-update');
    } catch (error) {
      warn('配置热更新处理失败', error?.message ?? error);
    }
  });

  // 插件卸载时：清掉所有定时器与正在朗读的进程。
  ctx.effect(() => () => {
    disposed = true;
    for (const state of states.values()) {
      state.disposed = true;
      if (state.timer !== null) clearTimeout(state.timer);
    }
    states.clear();
    sessions.clear();
    // 拆通路：先 duplex（中止在飞识别）→ 内核（quit + 清临时目录）→ 引擎（停播报）。
    teardownPath();
  }, 'dsh-stage-speak.teardown');

  journal.write('ready', [
    `pid=${process.pid}`,
    `platform=${process.platform}`,
    `dsh=${String(ctx.get('dshVersion') ?? 'n/a')}`,
    `llm=${llm === undefined ? 'off' : 'on'}`,
    `voice=${config.voice === '' ? '(system default)' : config.voice}`,
    // 格式与 V1.8.0 一致（便于按 `duplex=` 检索）：档位 + 内核/识别是否真的就位。
    `duplex=${config.mode}${pathState().bargeIn ? (audioCore === null ? '+kernel-missing' : '+kernel') : ''}${pathState().duplex ? (duplex === null ? '+asr-off' : '+asr') : ''}`,
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
