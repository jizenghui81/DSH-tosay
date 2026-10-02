// audio-core.js — 音频内核子进程客户端（半双工 barge-in 的宿主侧半边）。
//
// 内核（`engine/audio-core`，Swift 编译产物）是一个**常驻**子进程：
//   常开麦克风 + AEC（回声消除）+ 自适应 VAD，并且**由它负责播放播报音频**——
//   播放与采集同处一个 AVAudioEngine，AEC 才拿得到精确的回声参考，
//   否则"自己念给自己听"会被自己的 VAD 当成"用户在说话"，一播就自我打断。
//
// 协议：stdin / stdout 各一行一个 JSON（JSON Lines）。入站 cmd：
//   {"cmd":"play","path":"/abs/x.mp3","id":"..."}  {"cmd":"stop","reason":"barge-in"}
//   {"cmd":"ping"}  {"cmd":"quit"}
// 出站 ev：
//   {"ev":"ready",...} {"ev":"calibrated",...} {"ev":"started","id":...}
//   {"ev":"finished","id":...} {"ev":"stopped","id":...,"reason":...}
//   {"ev":"voice","level":-44.9}   ← barge-in 触发点
//   {"ev":"utterance-file","path":"<绝对路径>","id":"utt-000001.wav","seconds":3.2,"reason":"silence"}
//                                   ↑ 全双工分句落盘（仅在 ASR_ENABLED=1 + ASR_UTTERANCE_DIR 时上报）
//   {"ev":"silence",...} {"ev":"heartbeat",...} {"ev":"error","message":...}
//
// 全双工（`mode: 'full'`）多两个环境变量：
//   ASR_ENABLED=1           让内核认领录音、分句、写盘（**不再**自己调云端 ASR）
//   ASR_UTTERANCE_DIR=<目录> 分句 WAV 的落盘目录（16kHz 单声道 PCM16，规范 44 字节头）
// 内核只负责写盘 + 报路径；"读文件 → 送识别 → 注入会话"在 lib/duplex.js。
//
// ⚠️ 本仓库踩过的两个坑（违反会静默失败）：
//   1. `SubprocessSpawnSpec.cwd` **必填**：漏了 spawn 会同步抛错，而错误很容易被吞掉，
//      表现就是"插件看着正常，但 barge-in 永远不触发"。
//   2. 内核是**常驻**的：绝不能等 `handle.done` 才去读 stdout（那是死等），
//      必须挂在 stdout 数据流上逐行解析。
//
// 设计底线：内核不存在 / 启动失败 / 宿主不提供双向管道 → 一律返回 `null` 并留日志。
// 调用方据此退回原来的"wrapper 自播"路径 —— barge-in 是锦上添花，绝不能把播报本身搞哑。
//
// ⚠️ 工厂是**同步**的：`apply()` 必须同步注册事件监听，不能为了等内核就绪而变成 async，
// 否则加载期的事件会丢。所以这里只做同步可判定的检查（存在性 + spawn 同步抛错），
// 运行期的失败（管道断开、内核崩溃）走 `stats().alive === false` + 事件回调降级。

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 插件包根目录（本文件位于 lib/，上一级即包根）。默认内核就在包根的 engine/ 下。 */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * 内核一帧的时长（毫秒）。音频内核用 `installTap(bufferSize: 1024)` @48kHz
 * （见 `engine/audio-core.swift`），所以 `VAD_RELEASE_FRAMES` 与毫秒的换算是这个常数。
 */
const FRAME_MS = (1024 / 48000) * 1000;

/**
 * 解析音频内核路径。约定与 `engine.js` 的 `resolveEnginePath` 完全一致：
 *   `./x` `../x` → 相对**插件包根**解析（默认 `./engine/audio-core`，随包分发、不含绝对路径）
 *   `其他`        → 原样使用（绝对路径 / 裸命令名）
 * @param {unknown} spec - `config.audioCorePath` 的原始值。
 * @returns {string} 可直接交给 spawn 的路径；空串表示未配置。
 */
export function resolveAudioCorePath(spec) {
  const value = typeof spec === 'string' ? spec.trim() : '';
  if (value === '') return '';
  if (value.startsWith('./') || value.startsWith('../')) return resolve(PACKAGE_ROOT, value);
  return value;
}

/**
 * 启动音频内核客户端。
 *
 * @param {object} deps - 依赖。
 * @param {object} deps.subprocess - `ctx.subprocess`（宿主子进程服务，必需）。
 * @param {object} [deps.logger] - 宿主 logger；失败只 warn，不上抛。
 * @param {object} [deps.config] - 已解析配置（audioCorePath / cwd / graceMs / bargeIn* / asr*）。
 *   `config.asrEnabled === true` 时下发 `ASR_ENABLED=1` 与 `ASR_UTTERANCE_DIR`（全双工分句落盘）。
 * @returns {object|null} 客户端；内核不可用时返回 null（调用方走原路径）。
 */
export function createAudioCore(deps = {}) {
  const { subprocess, logger, config = {} } = deps;

  const warn = (message, detail) => {
    if (logger === undefined) return;
    try {
      logger.warn(`dsh-stage-speak: ${message}${detail === undefined ? '' : ` (${String(detail)})`}`);
    } catch { /* 日志失败无所谓 */ }
  };

  if (subprocess === undefined || subprocess === null || typeof subprocess.spawn !== 'function') {
    warn('宿主没有可用的 subprocess 服务，barge-in 关闭');
    return null;
  }

  const target = resolveAudioCorePath(config.audioCorePath);
  if (target === '') {
    warn('未配置 audioCorePath，barge-in 关闭');
    return null;
  }
  // 相对包根的写法已经被解析成绝对路径；绝对路径能直接判断"内核到底编出来没有"。
  // 裸命令名（不含分隔符）交给 PATH，不做存在性检查。
  if (isAbsolute(target) && !existsSync(target)) {
    warn(`音频内核不存在，barge-in 关闭：${target}（先跑 engine/build-audio-core.sh）`);
    return null;
  }

  // VAD 参数经环境变量下发（内核启动时读取，改配置需重建内核）。
  const env = {};
  if (Number.isFinite(config.bargeInOverDb) && config.bargeInOverDb > 0) {
    env.VAD_OVER_DB = String(config.bargeInOverDb);
  }
  // 播放期的更严门限（防自打断）；内核里同样有默认值，这里只在配置有效时覆盖。
  if (Number.isFinite(config.bargeInOverDbPlaying) && config.bargeInOverDbPlaying > 0) {
    env.VAD_OVER_DB_PLAYING = String(config.bargeInOverDbPlaying);
  }
  if (Number.isFinite(config.bargeInReleaseMs) && config.bargeInReleaseMs > 0) {
    env.VAD_RELEASE_FRAMES = String(Math.max(1, Math.round(config.bargeInReleaseMs / FRAME_MS)));
  }

  // ── 全双工：让内核把每句话写成 WAV 并报路径（识别在 lib/duplex.js 做）──────────
  // 目录必须先建好：内核落盘失败只会报 utterance-failed，但那时这一句已经丢了。
  // 目录是我们自己建的（临时目录）才在 dispose 时删；调用方显式指定的一律不动。
  let utteranceDir = '';
  let ownsUtteranceDir = false;
  if (config.asrEnabled === true) {
    const wanted = typeof config.asrUtteranceDir === 'string' ? config.asrUtteranceDir.trim() : '';
    try {
      if (wanted !== '') {
        utteranceDir = wanted;
        mkdirSync(utteranceDir, { recursive: true });
      } else {
        utteranceDir = mkdtempSync(join(tmpdir(), 'dsh-stage-speak-asr-'));
        ownsUtteranceDir = true;
      }
      env.ASR_ENABLED = '1';
      env.ASR_UTTERANCE_DIR = utteranceDir;
    } catch (error) {
      warn('全双工录音目录建不出来，本次退回半双工（不落盘、不注入）', error?.message ?? error);
      utteranceDir = '';
      ownsUtteranceDir = false;
      delete env.ASR_ENABLED;
      delete env.ASR_UTTERANCE_DIR;
    }
  }
  const cwd = typeof config.cwd === 'string' && config.cwd.trim() !== '' ? config.cwd.trim() : homedir();
  const graceMs = Number.isFinite(config.graceMs) && config.graceMs > 0 ? config.graceMs : 4000;

  let handle;
  try {
    // ⚠️ cwd 必填、且 spawn 会在 cwd/graceMs 非法时**同步抛错** —— 这里必须接住，
    //    否则插件加载直接失败。stdin/stdout 都要 'pipe'：JSON Lines 是双向协议。
    handle = subprocess.spawn({
      argv: [target],
      cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs,
      ...(Object.keys(env).length === 0 ? {} : { env }),
    });
  } catch (error) {
    warn('音频内核启动失败，barge-in 关闭', error?.message ?? error);
    return null;
  }

  // 宿主换了个不支持双向管道的 provider 时，宁可不启用也不能半残。
  if (handle === null || typeof handle !== 'object'
    || typeof handle.stdin?.write !== 'function'
    || typeof handle.stdout?.on !== 'function') {
    try { handle?.terminate?.(); } catch { /* 忽略 */ }
    warn('音频内核没有可用的双向管道，barge-in 关闭');
    return null;
  }

  // ── 状态 ────────────────────────────────────────────────────────────────
  let alive = true;
  let ready = false;
  let buffer = '';
  let lastError = null;
  /** @type {Map<string, Function[]>} 事件名 → 回调列表。 */
  const listeners = new Map();
  /** 正在等结果的播报：id → {resolve, timer}。 */
  const pending = new Map();
  const counted = { events: 0, errors: 0, started: 0, finished: 0, stopped: 0, voices: 0, utterances: 0 };

  function on(kind, handler) {
    if (typeof kind !== 'string' || kind === '' || typeof handler !== 'function') return;
    const list = listeners.get(kind) ?? [];
    list.push(handler);
    listeners.set(kind, list);
  }

  function emitTo(kind, payload) {
    for (const handler of listeners.get(kind) ?? []) {
      try {
        handler(payload);
      } catch (error) {
        warn(`内核事件回调失败（${kind}）`, error?.message ?? error);
      }
    }
  }

  // 也接受 `createAudioCore({ onVoice, onStarted, onFinished, onStopped, onError })` 这种写法
  // （等价于 `on('voice', onVoice)`）；两种都支持，调用方按顺手挑。
  // ⚠️ 事件名到回调名的映射是**显式表**：`utterance-file` 带连字符，不能靠首字母大写拼。
  const NAMED_CALLBACKS = {
    ready: 'onReady',
    voice: 'onVoice',
    started: 'onStarted',
    finished: 'onFinished',
    stopped: 'onStopped',
    error: 'onError',
    'utterance-file': 'onUtteranceFile',
  };
  for (const [kind, named] of Object.entries(NAMED_CALLBACKS)) {
    if (typeof deps[named] === 'function') on(kind, deps[named]);
  }

  function write(object) {
    if (!alive) return false;
    try {
      handle.stdin.write(`${JSON.stringify(object)}\n`);
      return true;
    } catch (error) {
      lastError = error?.message ?? String(error);
      warn('写内核命令失败', lastError);
      return false;
    }
  }

  /** 结束一条在等的播报（finished / stopped / 超时 / 内核退出）。 */
  function settle(id, outcome) {
    const key = String(id ?? '');
    const entry = pending.get(key);
    if (entry === undefined) return;
    pending.delete(key);
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.resolve(outcome);
  }

  function dispatch(event) {
    counted.events += 1;
    switch (event.ev) {
      case 'ready':
        ready = true;
        emitTo('ready', event);
        return;
      case 'voice':
        counted.voices += 1;
        emitTo('voice', event);
        return;
      case 'utterance-file':
        // 全双工的关键事件：一句录音已落盘，交给 lib/duplex.js 去识别 + 注入。
        // 这里只透传，不读文件、不做识别 —— 内核的音频线程绝不能等网络。
        counted.utterances += 1;
        emitTo('utterance-file', event);
        return;
      case 'started':
        counted.started += 1;
        emitTo('started', event);
        return;
      case 'finished':
        counted.finished += 1;
        settle(event.id, { status: 'finished', id: String(event.id ?? '') });
        emitTo('finished', event);
        return;
      case 'stopped':
        counted.stopped += 1;
        settle(event.id, { status: 'stopped', id: String(event.id ?? ''), reason: event.reason });
        emitTo('stopped', event);
        return;
      case 'error':
        counted.errors += 1;
        lastError = String(event.message ?? 'unknown');
        warn(`音频内核报错：${lastError}`);
        emitTo('error', lastError);
        return;
      default:
        // heartbeat / calibrated / silence / pong 等：谁订阅谁处理。
        emitTo(String(event.ev ?? ''), event);
    }
  }

  function onStdoutData(chunk) {
    buffer += typeof chunk === 'string' ? chunk : String(chunk);
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const text = line.trim();
      if (text === '') continue;
      let event = null;
      try {
        event = JSON.parse(text);
      } catch {
        // 非 JSON 行（例如内核被别的库污染了 stdout）只计数，不影响协议。
        counted.errors += 1;
        continue;
      }
      if (event !== null && typeof event === 'object') dispatch(event);
    }
  }

  function onStdioError(error) {
    lastError = error?.message ?? String(error);
    warn('内核管道错误', lastError);
  }

  function markDead(reason) {
    if (!alive) return;
    alive = false;
    lastError = reason;
    warn(`${reason}（barge-in 停用，播报自动退回原路径）`);
    for (const key of [...pending.keys()]) settle(key, { status: 'exited', id: key });
    emitTo('exit', reason);
  }

  try {
    handle.stdout.setEncoding?.('utf8');
    handle.stdout.on('data', onStdoutData);
    handle.stdout.on('error', onStdioError);
    handle.stdin.on('error', onStdioError);
    handle.stderr?.setEncoding?.('utf8');
    handle.stderr?.on?.('data', (chunk) => {
      const text = String(chunk).trim();
      if (text !== '') warn(`内核 stderr：${text.slice(0, 200)}`);
    });
    handle.stderr?.on?.('error', onStdioError);
    // 内核退出/崩溃：标记不可用并唤醒所有在等的播报，避免 pump 永久挂住。
    if (handle.done !== undefined && typeof handle.done.then === 'function') {
      handle.done.then(() => markDead('音频内核已退出'), () => markDead('音频内核启动或运行失败'));
    }
  } catch (error) {
    try { handle.terminate?.(); } catch { /* 忽略 */ }
    warn('挂载内核管道失败，barge-in 关闭', error?.message ?? error);
    return null;
  }

  return {
    /** 内核可执行文件路径（排障用）。 */
    path: target,
    /** 全双工分句落盘目录；空串 = 本次没启用全双工（排障用）。 */
    utteranceDir,
    on,
    /**
     * 播放一个本地音频文件。返回的 Promise 在**这一条**播完 / 被打断 / 超时后 settle。
     * @param {string} path - 绝对路径。
     * @param {string} id - 调用方持有的标识，用于对齐事件。
     * @param {{timeoutMs?: number}} [options] - 看门狗超时（防内核卡死占住队列）。
     * @returns {Promise<{status: string, id: string, reason?: string}>}
     */
    play(path, id, options = {}) {
      const key = String(id ?? '');
      if (!alive) return Promise.resolve({ status: 'dead', id: key });
      if (typeof path !== 'string' || path === '') return Promise.resolve({ status: 'invalid', id: key });
      const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 0;
      const result = new Promise((resolvePromise) => {
        const entry = { resolve: resolvePromise, timer: null };
        if (timeoutMs > 0) {
          entry.timer = setTimeout(() => {
            if (pending.delete(key)) resolvePromise({ status: 'timeout', id: key });
          }, timeoutMs);
        }
        pending.set(key, entry);
      });
      if (!write({ cmd: 'play', path, id: key })) settle(key, { status: 'dead', id: key });
      return result;
    },
    /** 停播。内核**无论是否在播都会回一个 `stopped`**，所以这里不需要额外状态。 */
    stop(reason = 'requested') {
      return write({ cmd: 'stop', reason: String(reason) });
    },
    /** 关掉内核：先 quit、再关 stdin（内核的 readLine 收到 EOF 也会退出）。 */
    dispose() {
      if (alive) {
        write({ cmd: 'quit' });
        try { handle.stdin.end(); } catch { /* 忽略 */ }
        alive = false;
        for (const key of [...pending.keys()]) settle(key, { status: 'disposed', id: key });
      }
      // 自己建的临时录音目录要收干净（内核已退出，剩下的都是没人认领的残句）。
      // 调用方显式指定的目录一律不删 —— 那里可能还放着别人要的东西。
      // ⚠️ 必须放在 `alive` 判断**之外**：内核崩溃时 markDead 早就把 alive 置成 false 了，
      //    若跟着早退，临时目录永远清不掉。
      if (ownsUtteranceDir && utteranceDir !== '') {
        try { rmSync(utteranceDir, { recursive: true, force: true }); } catch { /* 删不掉不影响功能 */ }
      }
    },
    stats: () => ({
      alive,
      ready,
      playing: pending.size > 0,
      pending: pending.size,
      lastError,
      ...counted,
    }),
  };
}
