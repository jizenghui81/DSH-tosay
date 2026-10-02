// engine.js — 语音层：把一句话交给系统语音引擎，并保证同一时刻只有一个进程在念。
//
// 队列语义（这是"像跟真人交流"而不是"机器复读"的关键）：
//   - high 优先级（等你审批 / 出错）会打断当前播报，立刻开口；
//   - normal 优先级在忙时被合并，只保留最新的一条 —— 阶段摘要过期就没意义了；
//   - 任何失败只记日志，绝不向上抛，绝不影响会话。
//
// 两条播报路径（默认行为零回归）：
//   - `deps.audioCore === null`（默认）→ **wrapper 自播**：子进程合成 + afplay，与 v1.5.1 完全一致。
//   - `deps.audioCore` 给了     → **wrapper 只合成（MMX_SYNTH_ONLY）→ 音频内核播放**：
//     只有内核播出来的声音才带 AEC 回声参考，它才能在你开口时把自己静音（barge-in）。

import { PRIORITY } from './activity.js';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';

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
 * @param {string} [voiceOverride] - **逐次播报的音色**（方案 A：音色绑定会话）。
 *   留空则跟随 `cfg.voice`。⚠️ 只有真正拿到备用音色的会话才会带上它，
 *   所以主音色路径（包内 wrapper 读 ~/.dsh/tools/minimax-voice.txt）完全不受影响。
 * @returns {{argv: string[], env?: Record<string,string>}} spawn 参数。
 */
export function buildSpeechArgv(platform, executable, text, cfg, voiceOverride = '') {
  const override = typeof voiceOverride === 'string' ? voiceOverride.trim() : '';
  const voice = override !== '' ? override : cfg.voice.trim();
  // 包内 MiniMax wrapper 会忽略注入的 flag（它取最后一个 argv 当文本），只认 MMX_VOICE。
  // 因此覆盖音色必须同时经环境变量下发，否则"按会话换音色"根本不会生效。
  const env = override === '' ? undefined : { MMX_VOICE: override };
  if (platform === 'darwin') {
    const argv = [executable];
    if (voice !== '') argv.push('-v', voice);
    if (Number.isFinite(cfg.rate) && cfg.rate > 0) argv.push('-r', String(Math.round(cfg.rate)));
    argv.push(text);
    return env === undefined ? { argv } : { argv, env };
  }

  if (platform === 'win32') {
    const rate = Number.isFinite(cfg.rate) ? Math.max(-10, Math.min(10, Math.round(cfg.rate))) : 0;
    const volume = Number.isFinite(cfg.volume) ? Math.max(0, Math.min(100, Math.round(cfg.volume))) : 100;
    const select = voice === '' ? '' : '$s.SelectVoice($env:STAGE_SPEAK_VOICE);';
    const script = [
      'Add-Type -AssemblyName System.Speech;',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
      select,
      `$s.Rate = ${rate}; $s.Volume = ${volume};`,
      '$s.Speak($env:STAGE_SPEAK_TEXT);',
    ].join(' ');
    const winEnv = { STAGE_SPEAK_TEXT: text, ...(env ?? {}) };
    if (voice !== '') winEnv.STAGE_SPEAK_VOICE = voice;
    return { argv: [executable, '-NoProfile', '-NonInteractive', '-Command', script], env: winEnv };
  }

  // 其他平台：只能靠用户显式给的模板。
  const argv = [executable];
  if (voice !== '') argv.push(voice);
  argv.push(text);
  return env === undefined ? { argv } : { argv, env };
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
 * @param {object} deps - {subprocess, logger, config, onError?, audioCore?, onBargeIn?}。
 *   `audioCore` 是 `lib/audio-core.js` 的客户端；给了就走"wrapper 合成 → 内核播放"，
 *   没给（或内核不可用）则完全保持 v1.5.1 的 wrapper 自播行为。
 *   `onBargeIn(event)` 在内核报 `voice` 时被调用（引擎自己随后会 `interrupt`）。
 * @returns {{speak: Function, interrupt: Function, dispose: Function, stats: Function}}
 */
export function createSpeechEngine(deps) {
  const { subprocess, logger, config, onError, audioCore = null, onBargeIn } = deps;

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
  /** 内核是否正在播（内核路径下 `active` 只在合成那一小段有值）。 */
  let kernelPlaying = false;
  let kernelId = '';

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

  /** 内核此刻是否可用（拿不到 stats 就按可用处理，出错由 play 兜底）。 */
  function kernelUsable() {
    if (audioCore === null || typeof audioCore.play !== 'function') return false;
    try {
      const snapshot = typeof audioCore.stats === 'function' ? audioCore.stats() : undefined;
      return snapshot === undefined || snapshot === null || snapshot.alive !== false;
    } catch (error) {
      warn('读取内核状态失败', error?.message ?? error);
      return false;
    }
  }

  /** 让内核停播（在播 / 不在播都安全：内核一定会回一个 stopped）。 */
  function stopKernel(reason) {
    if (audioCore === null || typeof audioCore.stop !== 'function') return;
    try {
      audioCore.stop(reason ?? 'interrupt');
    } catch (error) {
      warn('停内核播放失败', error?.message ?? error);
    }
  }

  function killActive(reason) {
    // 内核路径下 `active` 只是"合成"那一小段；真正出声的是内核，两边都要停。
    stopKernel(reason);
    if (active === null) return;
    try {
      active.terminate();
    } catch (error) {
      warn('打断当前播报失败', error?.message ?? error);
    }
  }

  /** 从 synth-only wrapper 的 stdout 里取出 mp3 绝对路径（最后一行绝对路径）。 */
  function readSynthPath(handle) {
    try {
      const reader = handle?.collected?.stdout;
      if (reader === undefined || typeof reader.readFrom !== 'function') return '';
      const text = String(reader.readFrom(0)?.text ?? '');
      const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (isAbsolute(lines[i])) return lines[i];
      }
      return '';
    } catch (error) {
      warn('读取合成结果失败', error?.message ?? error);
      return '';
    }
  }

  /** wrapper 自播（v1.5.1 原路径）：子进程自己合成 + afplay。 */
  async function playViaWrapper(item, controller) {
    const executable = await resolveExecutable();
    const { argv, env } = buildSpeechArgv(process.platform, executable, item.text, config, item.voice);
    const handle = subprocess.spawn(buildSpawnSpec(argv, env, controller.signal, config));
    // ⚠️ SubprocessSpawnSpec 的 cwd 是**必填**的（cwd: string，非可选），且 spawn 会在 cwd 非法时
    // **同步抛错**。漏了它 = 每次播报都静默失败（buildSpawnSpec 里已兜底，这里再强调一次）。
    active = handle;
    await handle.done;
    spoken += 1;
  }

  /** 内核路径：wrapper 只合成（MMX_SYNTH_ONLY）→ 路径交给内核播放。 */
  async function playViaKernel(item, controller, timeoutMs) {
    const executable = await resolveExecutable();
    const { argv, env } = buildSpeechArgv(process.platform, executable, item.text, config, item.voice);
    // ⚠️ 合成与播放必须分开：afplay 播的声音内核看不见，会被它自己的 VAD 当成用户在说话。
    const handle = subprocess.spawn(buildSpawnSpec(argv, { ...(env ?? {}), MMX_SYNTH_ONLY: '1' }, controller.signal, config));
    active = handle;
    await handle.done;
    active = null;

    const audioPath = readSynthPath(handle);
    if (audioPath === '') {
      // synth-only 下 wrapper 失败**不出声**（见 minimax-speak.sh）；这里只留痕，不假装念过。
      lastError = 'wrapper 没有产出音频（synth-only 失败）';
      warn(lastError);
      onError?.('synth-error', lastError);
      return;
    }

    const id = `say-${spoken + 1}`;
    spoken += 1;
    kernelPlaying = true;
    kernelId = id;
    try {
      const outcome = await audioCore.play(audioPath, id, { timeoutMs });
      const status = typeof outcome?.status === 'string' ? outcome.status : 'unknown';
      if (status === 'dead' || status === 'exited' || status === 'invalid') {
        lastError = `内核播放失败（${status}）`;
        warn(lastError);
        onError?.('speak-error', lastError);
      }
    } finally {
      kernelPlaying = false;
      kernelId = '';
    }
  }

  async function playOne(item) {
    const controller = new AbortController();
    const timeoutMs = Number.isFinite(config.speakTimeoutMs) && config.speakTimeoutMs > 0 ? config.speakTimeoutMs : SPEAK_TIMEOUT_MS;
    const timer = setTimeout(() => {
      controller.abort(new Error('speech timeout'));
    }, timeoutMs);

    try {
      if (kernelUsable()) await playViaKernel(item, controller, timeoutMs);
      else await playViaWrapper(item, controller);
    } catch (error) {
      lastError = error?.message ?? String(error);
      warn('播报失败', lastError);
      onError?.('speak-error', lastError);
    } finally {
      clearTimeout(timer);
      active = null;
      kernelPlaying = false;
      kernelId = '';
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
   * @param {string} [voice] - 逐次音色覆盖（方案 A：音色绑定会话）；留空跟随配置。
   */
  function speak(text, priority = PRIORITY.normal, voice = '') {
    if (disposed) return;
    if (typeof text !== 'string' || text.trim() === '') return;

    if (priority >= PRIORITY.high) {
      if (queue.length > 0) dropped += queue.length;
      queue = [{ text, priority, voice }];
      // 内核路径下 `active` 只在合成那一小段有值，所以还要看 kernelPlaying，
      // 否则急事会傻等内核把当前这条念完。
      if (active !== null || kernelPlaying) {
        interrupted += 1;
        killActive('priority');
      }
    } else if (active !== null || pumping) {
      // 忙：合并成"最新一条"，高优先级项保留。
      const keep = queue.filter((item) => item.priority >= PRIORITY.high);
      dropped += queue.length - keep.length;
      queue = [...keep, { text, priority, voice }];
    } else {
      queue.push({ text, priority, voice });
    }
    void pump();
  }

  /**
   * 打断当前播报并清空队列（barge-in / 新任务顶掉旧播报时用）。
   *
   * 语义与 `speak(high)` 的区别：这里**不排新内容**，只是让路。内核路径会下发 `stop`，
   * 内核随即回 `stopped`，在等的 `play()` 随之 settle，pump 才不会挂住。
   *
   * @param {string} [reason] - 记进内核日志的原因（`barge-in` / `dispose` / `priority`）。
   */
  function interrupt(reason = 'interrupt') {
    if (disposed) return;
    if (queue.length > 0) {
      dropped += queue.length;
      queue = [];
    }
    if (active !== null || kernelPlaying) interrupted += 1;
    killActive(reason);
  }

  function dispose() {
    disposed = true;
    if (queue.length > 0) dropped += queue.length;
    queue = [];
    killActive('dispose');
    if (audioCore !== null && typeof audioCore.dispose === 'function') {
      try {
        audioCore.dispose();
      } catch (error) {
        warn('关闭音频内核失败', error?.message ?? error);
      }
    }
  }

  // ── barge-in：内核报 `voice` → 让路 ─────────────────────────────────────
  // 引擎自己负责 interrupt（这样"voice 事件 = 立刻停播"是引擎的内建保证），
  // 外部 `onBargeIn` 只做留痕/统计 —— 刻意**不**让外部也调 interrupt，避免打断计数翻倍。
  if (audioCore !== null && typeof audioCore.on === 'function') {
    try {
      audioCore.on('voice', (event) => {
        try {
          if (typeof onBargeIn === 'function') onBargeIn(event);
        } catch (error) {
          warn('onBargeIn 回调失败', error?.message ?? error);
        }
        interrupt('barge-in');
      });
      audioCore.on('error', (message) => {
        lastError = String(message);
        onError?.('audio-core-error', lastError);
      });
    } catch (error) {
      warn('注册内核事件失败', error?.message ?? error);
    }
  }

  return {
    speak,
    interrupt,
    dispose,
    stats: () => ({
      spoken,
      dropped,
      interrupted,
      queued: queue.length,
      speaking: active !== null || kernelPlaying,
      kernel: audioCore !== null,
      kernelPlaying,
      kernelId,
      lastError,
    }),
  };
}
