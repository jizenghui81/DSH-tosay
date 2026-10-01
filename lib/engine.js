// engine.js — 语音层：把一句话交给系统语音引擎，并保证同一时刻只有一个进程在念。
//
// 队列语义（这是"像跟真人交流"而不是"机器复读"的关键）：
//   - high 优先级（等你审批 / 出错）会打断当前播报，立刻开口；
//   - normal 优先级在忙时被合并，只保留最新的一条 —— 阶段摘要过期就没意义了；
//   - 任何失败只记日志，绝不向上抛，绝不影响会话。

import { PRIORITY } from './activity.js';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** 默认的每句话最长播报时间，防止某个引擎卡死占住队列。 */
const SPEAK_TIMEOUT_MS = 120000;

/** 插件包根目录（本文件位于 lib/，上一级即包根）。自带引擎就放在包根的 engine/ 下。 */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * 解析 `engine` 配置指向的可执行文件。
 *
 * 约定（三种写法，语义互不歧义）：
 *   `''`            → 空串，调用方回落平台默认（macOS `say` / Windows `powershell`）
 *   `./x` `../x`    → 相对**插件包根目录**解析。自带引擎用这个写法，
 *                     不含任何绝对路径与用户名，因此随包分发即可跨机器运行。
 *   `其他`           → 原样交给 `subprocess.resolveExecutable`：绝对路径原样使用，
 *                     裸命令名按 PATH 解析（例如 `say`）。
 *
 * @param {unknown} spec - `config.engine` 的原始值。
 * @returns {string} 可直接交给 resolveExecutable 的命令或路径；空串表示用平台默认。
 */
export function resolveEnginePath(spec) {
  const value = typeof spec === 'string' ? spec.trim() : '';
  if (value === '') return '';
  if (value.startsWith('./') || value.startsWith('../')) return resolve(PACKAGE_ROOT, value);
  return value;
}

/**
 * 构造一次朗读的 argv 与环境覆盖。
 * @param {string} platform - process.platform。
 * @param {string} executable - 已解析的可执行文件路径。
 * @param {string} text - 要朗读的文本。
 * @param {object} cfg - 已解析配置。
 * @returns {{argv: string[], env?: Record<string,string>}} spawn 参数。
 */
export function buildSpeechArgv(platform, executable, text, cfg) {
  if (platform === 'darwin') {
    const argv = [executable];
    if (cfg.voice.trim() !== '') argv.push('-v', cfg.voice.trim());
    if (Number.isFinite(cfg.rate) && cfg.rate > 0) argv.push('-r', String(Math.round(cfg.rate)));
    argv.push(text);
    return { argv };
  }

  if (platform === 'win32') {
    const rate = Number.isFinite(cfg.rate) ? Math.max(-10, Math.min(10, Math.round(cfg.rate))) : 0;
    const volume = Number.isFinite(cfg.volume) ? Math.max(0, Math.min(100, Math.round(cfg.volume))) : 100;
    const select = cfg.voice.trim() === '' ? '' : '$s.SelectVoice($env:STAGE_SPEAK_VOICE);';
    const script = [
      'Add-Type -AssemblyName System.Speech;',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
      select,
      `$s.Rate = ${rate}; $s.Volume = ${volume};`,
      '$s.Speak($env:STAGE_SPEAK_TEXT);',
    ].join(' ');
    const env = { STAGE_SPEAK_TEXT: text };
    if (cfg.voice.trim() !== '') env.STAGE_SPEAK_VOICE = cfg.voice.trim();
    return { argv: [executable, '-NoProfile', '-NonInteractive', '-Command', script], env };
  }

  // 其他平台：只能靠用户显式给的模板。
  const argv = [executable];
  if (cfg.voice.trim() !== '') argv.push(cfg.voice.trim());
  argv.push(text);
  return { argv };
}

/**
 * 构造一个**完全符合 `SubprocessSpawnSpec`** 的 spawn 参数。
 *
 * 契约（`ctx.subprocess` 的 Service Definition）：
 *   argv: readonly string[]; cwd: string; stdio: SubprocessStdio; graceMs: number;
 *   signal?: AbortSignal; env?: NodeJS.ProcessEnv;
 * 其中 `cwd` 是**必填**（不是 `cwd?`），且 `spawn` 会在 cwd 非法时同步抛错。
 * `SubprocessOutputMode` 只有 `'pipe' | 'inherit' | SubprocessCollect` ——
 * `'ignore'` 仅对 `stdin` 合法。这里集中构造，并由单测守着，避免再漏字段。
 *
 * @param {string[]} argv - 完整命令行。
 * @param {Record<string,string>|undefined} env - 环境覆盖。
 * @param {AbortSignal} signal - 取消信号。
 * @param {object} config - 已解析配置（用 cwd / graceMs）。
 * @returns {object} 合规的 spawn 参数。
 */
export function buildSpawnSpec(argv, env, signal, config) {
  const graceMs = Number.isFinite(config.graceMs) && config.graceMs > 0 ? config.graceMs : 4000;
  const cwd = typeof config.cwd === 'string' && config.cwd.trim() !== '' ? config.cwd.trim() : homedir();
  return {
    argv,
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 4096 },
      stderr: { maxBytes: 4096 },
    },
    graceMs,
    signal,
    ...(env === undefined ? {} : { env }),
  };
}

/**
 * 建一个串行语音引擎。
 * @param {object} deps - {subprocess, logger, config}。
 * @returns {{speak: (text: string, priority?: number) => void, dispose: () => void, stats: () => object}}
 */
export function createSpeechEngine(deps) {
  const { subprocess, logger, config, onError } = deps;

  /** @type {Array<{text: string, priority: number}>} */
  let queue = [];
  /** @type {object|null} */
  let active = null;
  let pumping = false;
  let disposed = false;
  let executableCache = null;
  let spoken = 0;
  let dropped = 0;
  let interrupted = 0;
  let lastError = null;

  function warn(message, detail) {
    if (logger === undefined) return;
    try {
      logger.warn(`dsh-stage-speak: ${message}${detail === undefined ? '' : ` (${String(detail)})`}`);
    } catch {
      /* 日志失败无所谓 */
    }
  }

  async function resolveExecutable() {
    if (executableCache !== null) return executableCache;
    // `./` `../` 开头的写法相对包根解析（自带引擎），其余原样交给宿主解析。
    const explicit = resolveEnginePath(config.engine);
    const command = explicit !== ''
      ? explicit
      : (process.platform === 'darwin' ? 'say' : (process.platform === 'win32' ? 'powershell' : 'say'));
    executableCache = await subprocess.resolveExecutable(command);
    return executableCache;
  }

  function killActive() {
    if (active === null) return;
    try {
      active.terminate();
    } catch (error) {
      warn('打断当前播报失败', error?.message ?? error);
    }
  }

  async function playOne(item) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error('speech timeout'));
    }, Number.isFinite(config.speakTimeoutMs) && config.speakTimeoutMs > 0 ? config.speakTimeoutMs : SPEAK_TIMEOUT_MS);

    try {
      const executable = await resolveExecutable();
      const { argv, env } = buildSpeechArgv(process.platform, executable, item.text, config);
      // ⚠️ SubprocessSpawnSpec 的 cwd 是**必填**的（cwd: string，非可选），
      // 且 spawn 会在 cwd 非法时**同步抛错**。漏了它 = 每次播报都静默失败。
      // stdout/stderr 只接受 'pipe' | 'inherit' | 收集对象；'ignore' 仅 stdin 可用。
      const handle = subprocess.spawn(buildSpawnSpec(argv, env, controller.signal, config));
      active = handle;
      await handle.done;
      spoken += 1;
    } catch (error) {
      lastError = error?.message ?? String(error);
      warn('播报失败', lastError);
      onError?.('speak-error', lastError);
    } finally {
      clearTimeout(timer);
      active = null;
    }
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length > 0 && !disposed) {
        const item = queue.shift();
        await playOne(item);
      }
    } finally {
      pumping = false;
    }
  }

  /**
   * 排入一句播报。
   * @param {string} text - 已清洗的文本。
   * @param {number} priority - PRIORITY 之一。
   */
  function speak(text, priority = PRIORITY.normal) {
    if (disposed) return;
    if (typeof text !== 'string' || text.trim() === '') return;

    if (priority >= PRIORITY.high) {
      if (queue.length > 0) dropped += queue.length;
      queue = [{ text, priority }];
      if (active !== null) {
        interrupted += 1;
        killActive();
      }
    } else if (active !== null || pumping) {
      // 忙：合并成"最新一条"，高优先级项保留。
      const keep = queue.filter((item) => item.priority >= PRIORITY.high);
      dropped += queue.length - keep.length;
      queue = [...keep, { text, priority }];
    } else {
      queue.push({ text, priority });
    }
    void pump();
  }

  function dispose() {
    disposed = true;
    if (queue.length > 0) dropped += queue.length;
    queue = [];
    killActive();
  }

  return {
    speak,
    dispose,
    stats: () => ({ spoken, dropped, interrupted, queued: queue.length, speaking: active !== null, lastError }),
  };
}
