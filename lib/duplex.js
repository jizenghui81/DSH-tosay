// duplex.js — 全双工（`mode: 'full'`）的「识别 → 注入」半边。
//
// 分工（见 lib/audio-core.js 的头注释）：
//   内核：常开麦克风 + AEC + VAD，判出一句话、**峰值归一化后写成 16kHz 单声道 PCM16 WAV**，
//         报 `{"ev":"utterance-file","path":...,"id":"utt-000001.wav",...}`。
//   本文件：读那个 WAV → `ctx.speechToText`（本机 SenseVoice）→ 识别文本作为**用户消息**
//         插进当前回合（`agent.steer` / `agent.followup`）→ 删掉临时 WAV。
//
// 为什么识别不放在内核里：内核只有 MiniMax 云端 ASR 的旧路径；本地 SenseVoice 由宿主提供，
// 只有 Node 侧拿得到（`ctx.speechToText`）。内核因此只做"落盘 + 报路径"，不认识识别服务。
//
// ⚠️ 三条硬约束（都有真实踩坑背景）：
//   1. `ctx.speechToText` / `ctx.agents` 是**可选**服务，用 `ctx.get()` 取（见 lib/index.js）。
//      缺失时本模块整条通路关闭，**只 warn 不抛**。
//   2. 注入的必须是**完整 UserMessage 对象**：`dsh-session` 的 `assertMessageEventShape()`
//      要求 `id` 非空 string、`role === 'user'`、`source.kind` 非空 string、`content` 是数组。
//      传纯字符串会被直接拒。
//   3. `speechToText.transcribe(spec, signal)` 的第二参**必填**（内部第一行就是
//      `signal.throwIfAborted()`），传 undefined 会 TypeError。
//
// 设计底线：任何一步失败都只记日志 + journal 留痕，**绝不影响会话**（也不影响播报）。

import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { resolve as resolvePath, sep } from 'node:path';

/**
 * 单次识别的看门狗上限（毫秒）。
 *
 * 为什么必须有：SenseVoice 首次识别要先拉模型（实测 230MB 已下载，仍需唤醒 worker），
 * 卡住时这个 Promise 会一直挂着；本插件是长驻的，挂住的识别会一直占着 `inFlight`。
 * 60 秒对"一句话识别"足够宽（provider 自己的 inferenceTimeoutMs 是 120 秒，这里更早兜底）。
 */
const TRANSCRIBE_TIMEOUT_MS = 60000;

/** 已处理句 id 的记忆上限。防重复注入只需要挡住"最近这一批"。 */
const SEEN_LIMIT = 256;

/** 判定"这就是自己刚念过的"的相似度阈值（0~1）。 */
const ECHO_SIMILARITY = 0.72;
/** 只跟这么久以内念过的文本比对（毫秒）：更早的内容被用户复述是合理的，不该误杀。 */
const ECHO_WINDOW_MS = 20000;

/**
 * 归一化文本：去掉标点、空白与大小写差异，只留"说了什么"。
 * @param {string} value - 原始文本。
 * @returns 归一化后的字符串。
 */
function normalizeForCompare(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

/**
 * 把文本切成字符二元组（中文没有词边界，二元组是最稳的粗粒度表示）。
 * @param {string} value - 归一化后的文本。
 * @returns {Set<string>} 二元组集合。
 */
function bigrams(value) {
  const set = new Set();
  for (let i = 0; i + 1 < value.length; i += 1) set.add(value.slice(i, i + 2));
  return set;
}

/**
 * 用"Dice 系数"比两段文本的重合度（对插入/删除比较宽容，适合识别结果与原文的比对）。
 * @param {string} a - 归一化文本 A。
 * @param {string} b - 归一化文本 B。
 * @returns {number} 0~1 的相似度。
 */
function similarity(a, b) {
  if (a === '' || b === '') return 0;
  if (a === b) return 1;
  // 短文本（1 个字）退化处理：直接看包含关系
  if (a.length < 2 || b.length < 2) return a.includes(b) || b.includes(a) ? 1 : 0;
  const setA = bigrams(a);
  const setB = bigrams(b);
  let shared = 0;
  for (const gram of setA) if (setB.has(gram)) shared += 1;
  return (2 * shared) / (setA.size + setB.size);
}

/**
 * 创建全双工通路。
 *
 * @param {object} deps - 依赖。
 * @param {object} [deps.speechToText] - `ctx.get('speechToText')`；缺省 = 通路不可用。
 * @param {object} [deps.logger] - 宿主 logger；失败只 warn。
 * @param {object} [deps.journal] - 留痕器（`{ write(kind, detail) }`）。
 * @param {object} [deps.config] - 已解析配置（duplexLanguage / duplexInjectMode）。
 * @param {string} [deps.utteranceDir] - 内核落盘目录；给了就只认这个目录里的文件。
 *   事件里带 `dir`（lib/index.js 会把 audioCore 的实际目录塞进去）时以事件为准。
 * @param {() => ({sessionId: string, agent: object}|null)} [deps.resolveTarget] - 每次注入前解析目标会话。
 * @param {(path: string) => Promise<Buffer>} [deps.readAudio] - 读音频（测试注入用）。
 * @param {(path: string) => Promise<void>} [deps.removeAudio] - 删音频（测试注入用）。
 * @returns {object} 通路对象：`available` / `handle(event)` / `stats()` / `dispose()`。
 */
export function createDuplex(deps = {}) {
  const { speechToText, logger, journal, config = {}, utteranceDir = '', resolveTarget } = deps;
  /** 最近念过的文本来源（由插件侧维护）。缺省 = 不做文本比对，只靠内核冷却窗。 */
  const recentSpeech = typeof deps.recentSpeech === 'function' ? deps.recentSpeech : () => [];
  /** `!== false` 时丢弃"起于播放冷却窗内"的句子（大概率是回声尾巴）。 */
  // 字段名与宿主 Config 对齐：`duplexEchoGuard`（默认 true）。
  const dropEchoTail = config.duplexEchoGuard;

  const warn = (message, detail) => {
    try {
      logger?.warn(`dsh-stage-speak: ${message}${detail === undefined ? '' : ` (${String(detail)})`}`);
    } catch { /* 日志失败无所谓 */ }
  };
  const note = (kind, detail) => {
    try { journal?.write?.(kind, detail); } catch { /* 留痕失败无所谓 */ }
  };

  const readAudio = typeof deps.readAudio === 'function' ? deps.readAudio : (path) => readFile(path);
  const removeAudio = typeof deps.removeAudio === 'function'
    ? deps.removeAudio
    : async (path) => { await rm(path, { force: true }); };

  const language = typeof config.duplexLanguage === 'string' && config.duplexLanguage.trim() !== ''
    ? config.duplexLanguage.trim()
    : 'zh';
  const injectMode = config.duplexInjectMode === 'followup' ? 'followup' : 'steer';

  const targetsInDir = typeof utteranceDir === 'string' && utteranceDir.trim() !== ''
    ? resolvePath(utteranceDir.trim())
    : '';

  /**
   * 判断一段识别文本是否"就是助手刚念过的内容"。
   *
   * @param {string} text - 识别结果。
   * @returns {string|null} 命中时返回可读说明（原文片段 + 相似度），未命中返回 null。
   */
  function matchRecentSpeech(text) {
    const target = normalizeForCompare(text);
    if (target === '') return null;
    let candidates = [];
    try {
      candidates = recentSpeech() ?? [];
    } catch {
      // 取不到就放行：宁可漏挡一次回声，也不要误杀用户真实说的话。
      return null;
    }
    const now = Date.now();
    for (const item of candidates) {
      const said = typeof item === 'string' ? item : item?.text ?? '';
      const at = typeof item === 'string' ? now : item?.at ?? now;
      if (now - at > ECHO_WINDOW_MS) continue;
      const score = similarity(target, normalizeForCompare(said));
      if (score >= ECHO_SIMILARITY) {
        return `相似度 ${score.toFixed(2)}：${String(said).slice(0, 30)}`;
      }
    }
    return null;
  }

  const available = speechToText !== undefined && speechToText !== null
    && typeof speechToText.resolve === 'function' && typeof speechToText.transcribe === 'function';
  if (!available) warn('没有可用的 speechToText 服务，全双工识别与注入关闭');

  /** 已认领的句 id（防同一句被注入两次）。 */
  const seen = new Set();
  const counted = { handled: 0, injected: 0, duplicates: 0, skipped: 0, failed: 0 };
  /** 在飞的识别：用于 dispose 时统一中止。 */
  const inflight = new Set();
  /** 在飞识别的中止手柄（dispose 时真的要 abort，光丢 Promise 停不下网络/推理）。 */
  const controllers = new Set();
  let disposed = false;

  /** 记住 id，并让集合不会无限长。 */
  function remember(id) {
    seen.add(id);
    if (seen.size > SEEN_LIMIT) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
  }

  /** 落盘文件是否真的在我们要的目录里（防"删到别人的文件"）。 */
  function insideUtteranceDir(path, root) {
    const base = typeof root === 'string' && root.trim() !== '' ? root.trim() : targetsInDir;
    if (base === '') return true;
    const absolute = resolvePath(path);
    const bound = resolvePath(base);
    return absolute === bound || absolute.startsWith(bound + sep);
  }

  /**
   * 处理一条 `utterance-file` 事件。
   *
   * 约定：**永不 reject**，返回值只用于日志与测试（`{status, ...}`）。
   * @param {object} event - 内核事件（`path` / `id` / `seconds`）。
   * @returns {Promise<{status: string, [key: string]: unknown}>} 处置结果。
   */
  async function handle(event) {
    counted.handled += 1;
    if (disposed) return { status: 'disposed' };

    const path = typeof event?.path === 'string' ? event.path : '';
    // 句 id 缺省时退回用路径当身份：总比"同一句注入两遍"强。
    const id = typeof event?.id === 'string' && event.id !== '' ? event.id : path;
    if (path === '' || id === '') {
      counted.skipped += 1;
      note('duplex-skipped', 'utterance-file 缺 path/id');
      return { status: 'bad-event' };
    }
    if (seen.has(id)) {
      // ⚠️ 重复事件**不能删文件**：第一份还在读，删了会让那次识别失败。
      counted.duplicates += 1;
      return { status: 'duplicate' };
    }
    remember(id);

    if (!insideUtteranceDir(path, event?.dir)) {
      counted.skipped += 1;
      note('duplex-skipped', `落盘文件不在录音目录内，拒绝处理：${path}`);
      warn('全双工收到目录外路径，已忽略', path);
      return { status: 'outside-dir' };
    }

    if (!available) {
      counted.skipped += 1;
      note('duplex-skipped', 'speechToText 不可用');
      await removeQuietly(path);
      return { status: 'no-service' };
    }

    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(new Error('transcribe timeout')), TRANSCRIBE_TIMEOUT_MS);
    const job = (async () => {
      try {
        let audio;
        try {
          audio = await readAudio(path);
        } catch (error) {
          counted.failed += 1;
          note('duplex-failed', `读录音失败：${error?.message ?? error}`);
          return { status: 'read-failed' };
        }

        let spec;
        try {
          spec = speechToText.resolve({ audio, language });
        } catch (error) {
          counted.failed += 1;
          note('duplex-failed', `resolve 失败：${error?.message ?? error}`);
          return { status: 'resolve-failed' };
        }

        let result;
        try {
          result = await speechToText.transcribe(spec, controller.signal);
        } catch (error) {
          counted.failed += 1;
          note('duplex-failed', `识别失败：${error?.message ?? error}`);
          return { status: 'transcribe-failed' };
        }

        // 结果形状是 provider 的 `transcriptSchema`：{ text, audioSeconds, inferenceSeconds }（strict）。
        // 同时容忍"直接回字符串"的旧/第三方 provider，免得换 provider 就静默哑掉。
        const text = (typeof result === 'string' ? result : result?.text ?? '').trim();
        if (text === '') {
          counted.skipped += 1;
          note('duplex-skipped', '识别结果为空，不注入');
          return { status: 'empty-text' };
        }

        // ── 第二层防自注入：冷却窗标记 + 与"最近念过的文本"比对 ──────────────────
        //
        // 为什么必须有这一层：真机实测到过——助手播报的内容被麦克风收回去、又被识别成
        // "用户说的话"注入了会话（日志时间线：07:03:47 播报 → 07:03:50 注入同一句）。
        // 内核的播放冷却窗是第一层（窗内提高门限、尽量不触发）；但识别是滞后的，
        // 冷却窗未必覆盖住尾部，所以这里兜底：**识别结果字面上就是刚念的内容**时丢弃。
        if (event.afterPlayback === true && dropEchoTail !== false) {
          counted.skipped += 1;
          note('duplex-skipped', `起于播放冷却窗内（疑似回声尾巴），不注入：${text.slice(0, 40)}`);
          return { status: 'echo-tail' };
        }
        const echo = dropEchoTail === false ? null : matchRecentSpeech(text);
        if (echo !== null) {
          counted.skipped += 1;
          note('duplex-skipped', `与最近播报高度重合（${echo}），判定为自己念的内容，不注入：${text.slice(0, 40)}`);
          return { status: 'echo-text' };
        }

        let target = null;
        try {
          target = typeof resolveTarget === 'function' ? resolveTarget() : null;
        } catch (error) {
          counted.failed += 1;
          note('duplex-failed', `解析目标会话失败：${error?.message ?? error}`);
          return { status: 'no-target' };
        }
        const agent = target?.agent;
        if (target === null || target === undefined || agent === undefined || agent === null) {
          counted.skipped += 1;
          note('duplex-skipped', `没有可注入的会话（${text.slice(0, 40)}）`);
          return { status: 'no-target' };
        }
        if (typeof agent.steer !== 'function' || typeof agent.followup !== 'function') {
          counted.failed += 1;
          note('duplex-failed', 'agents.get() 返回的对象没有 steer/followup');
          return { status: 'no-target' };
        }

        // ⚠️ 完整 UserMessage：见文件头注释的约束 2。缺一项就被 dsh-session 拒。
        const message = {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        };
        try {
          if (injectMode === 'followup') agent.followup(message);
          else agent.steer(message);
        } catch (error) {
          counted.failed += 1;
          note('duplex-failed', `注入失败：${error?.message ?? error}`);
          return { status: 'inject-failed' };
        }

        counted.injected += 1;
        note('duplex-injected', `session=${String(target.sessionId)}\t${injectMode}\t${text}`);
        return { status: 'injected', text, sessionId: String(target.sessionId), mode: injectMode };
      } finally {
        // 识别完（无论成败）都不再需要这条临时录音。
        await removeQuietly(path);
      }
    })();

    inflight.add(job);
    try {
      return await job;
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
      inflight.delete(job);
    }
  }

  async function removeQuietly(path) {
    try {
      await removeAudio(path);
    } catch { /* 删不掉只是留个临时文件，不影响功能 */ }
  }

  return {
    available,
    handle,
    stats: () => ({ ...counted, seen: seen.size, inflight: inflight.size, disposed }),
    dispose() {
      disposed = true;
      seen.clear();
      // 在飞的识别一律 abort：插件都卸载了，识别结果也没人接 （光丢 Promise 停不下推理）。
      for (const controller of [...controllers]) {
        try { controller.abort(new Error('duplex disposed')); } catch { /* 忽略 */ }
      }
      controllers.clear();
      inflight.clear();
    },
  };
}
