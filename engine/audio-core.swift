// audio-core.swift —— dsh-stage-speak 的音频内核（宿主侧常驻子进程）
//
// 职责（只做音频，不做业务）：
//   1. 常驻采集麦克风，开启 voice processing（AEC），消除"自己念给自己听"的回声；
//   2. 播放播报音频（替代 afplay），使播放与采集同处一个 AVAudioEngine —— AEC 才能拿到
//      精确的回声参考信号。这是实测能把回声压到只比底噪高 2.0 dB 的前提；
//   3. 用自适应能量门限做端点检测（VAD），在你开口时立刻上报 `voice` 事件，
//      从而让插件"闭嘴让路"（半双工）。
//
// 协议：stdin / stdout 各一行一个 JSON（JSON Lines），插件用管道与它对话。
//   入：{"cmd":"play","path":"/abs/x.mp3","id":"..."}  {"cmd":"stop"}  {"cmd":"ping"}  {"cmd":"quit"}
//   出：{"ev":"ready","sampleRate":48000}
//       {"ev":"started","id":"..."}  {"ev":"finished","id":"..."}
//       {"ev":"voice","level":-31.2}        检测到你在说话（Barge-in 触发点）
//       {"ev":"silence","level":-52.1}      说话结束
//       {"ev":"error","message":"..."}
//
// ⚠️ 踩坑备忘（本文件里已处理）：
//   1. voice processing 打开后，input 的格式是 **5 声道 / 浮点 / 非交织**，且 5 个声道内容相同。
//      若直接把多声道 buffer 交给"单声道输入"的转换器，AVAudioConverter 会**静默输出全零**
//      （表现为 rms=-120dBFS，看着像麦克风坏了）。必须先抽 ch0 组成浮点单声道 buffer 再转换。
//   2. 播放要经 mainMixer 并在启动前把 mixer→output 显式连成硬件格式，否则 kAUInitialize(-10875)。
//   3. macOS 的 voice processing 带 AGC，**绝对电平不可靠** —— 所以门限必须自适应，
//      不能写死 -40dBFS 这种常量。
//
// 编译：见同目录 build-audio-core.sh

import AVFoundation
import Foundation

// ── 协议输出 ────────────────────────────────────────────────────────────────
/// 输出锁：emit 会被采集回调、心跳定时器、ASR 回调、命令循环**同时**调用。
/// 不加锁的话多条 JSON 会交错写进 stdout，把行协议撕碎（插件端解析随机失败）。
let emitLock = NSLock()

/// 是否把每条事件同时镜像到 stderr。父进程被信号清掉时，stdout 会随之消失，
/// 排查时用 AUDIO_CORE_DEBUG=1 打开镜像即可留痕。
let mirrorToStderr = (ProcessInfo.processInfo.environment["AUDIO_CORE_DEBUG"] ?? "") == "1"

/// 往 stdout 写一行 JSON 事件。所有出站消息都走这里，保证一行一条、可被 readline 解析。
func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: []),
          let line = String(data: data, encoding: .utf8) else { return }
    emitLock.lock()
    defer { emitLock.unlock() }
    FileHandle.standardOutput.write(line.data(using: .utf8)!)
    if mirrorToStderr { FileHandle.standardError.write(line.data(using: .utf8)!) }
    FileHandle.standardOutput.write(Data([0x0A]))
    // 必须立刻刷出，否则插件要等缓冲满才收到事件 —— barge-in 的实时性全靠这一句。
    fflush(stdout)
}

func emitError(_ message: String) {
    emit(["ev": "error", "message": message])
}

// ── 可调参数（由插件经环境变量下发，缺省即下方默认值）────────────────────────
/// 判定"你在说话"时，需要高出底噪多少 dB。太小会被环境噪声误触发，太大会漏掉轻声起头。
let speechOverFloorDb = Double(ProcessInfo.processInfo.environment["VAD_OVER_DB"] ?? "") ?? 9.0
/// **播放期间**的触发门限（高出底噪多少 dB）。
/// 依据：外放时回声实测抬升约 5.5 dB，而你插话时嘴离麦克风很近、电平远高于此。
/// 用更严的门限把"自己念给自己听"挡在外面 —— 这是防自打断的第一道闸。
let speechOverFloorDbPlaying = Double(ProcessInfo.processInfo.environment["VAD_OVER_DB_PLAYING"] ?? "") ?? 14.0
/// 播放开始后的静默宽限期（秒）：这段时间内绝不触发，等电平/回声稳定下来。
let playingGraceSeconds = Double(ProcessInfo.processInfo.environment["VAD_PLAYING_GRACE"] ?? "") ?? 0.4
/// 判定"说完了"的回落余量（比触发门限低，避免一句话被切成好几段）。
let releaseOverFloorDb = Double(ProcessInfo.processInfo.environment["VAD_RELEASE_DB"] ?? "") ?? 4.0
/// 连续多少帧超阈值才算"真的开口"（去抖，防止单帧尖峰）。
let attackFrames = Int(ProcessInfo.processInfo.environment["VAD_ATTACK_FRAMES"] ?? "") ?? 3
/// 低于阈值连续多少帧才算"说完"（约 0.6s @1024 帧/48k，覆盖句中自然停顿）。
let releaseFrames = Int(ProcessInfo.processInfo.environment["VAD_RELEASE_FRAMES"] ?? "") ?? 30
/// 底噪自适应速度（指数滑动平均系数）。越小越稳、适应越慢。
/// ⚠️ 必须让它在"判定为正在说话"时**也能缓慢适应**，否则一旦误触发就自锁死：
///    门限被钉在很低的值，于是永远"在说话" —— 半双工会变成永久静音（实测踩过）。
let floorAdapt = Double(ProcessInfo.processInfo.environment["VAD_FLOOR_ADAPT"] ?? "") ?? 0.02
/// 复位（判定说完）时使用的较慢适应系数。
let floorAdaptWhileSpeaking = Double(ProcessInfo.processInfo.environment["VAD_FLOOR_ADAPT_SPEAKING"] ?? "") ?? 0.004
/// 启动校准期（秒）：这段时间只测底噪、**绝不触发**，避免把开机瞬间的噪声当成"你在说话"。
let calibrateSeconds = Double(ProcessInfo.processInfo.environment["VAD_CALIBRATE_SECONDS"] ?? "") ?? 1.5
/// 校准期的快速适应系数（让底噪迅速爬到真实环境电平）。
let floorAdaptCalibrating = Double(ProcessInfo.processInfo.environment["VAD_FLOOR_ADAPT_CALIBRATING"] ?? "") ?? 0.25
/// 触发所需的**绝对**电平下限（dBFS）。相对门限不够用时兜底：安静房间里轻声起头也能触发，
/// 而环境噪声本身很高时不会因为"相对高 9dB"就乱触发。
let absoluteTriggerDb = Double(ProcessInfo.processInfo.environment["VAD_ABSOLUTE_DB"] ?? "") ?? -55.0
/// 底噪自适应值的**下限**（dBFS）：环境本身很吵时，别让门限被拉到不合理的低值。
let absoluteFloorDb = Double(ProcessInfo.processInfo.environment["VAD_ABS_FLOOR_DB"] ?? "") ?? -75.0

// ── 音频引擎 ────────────────────────────────────────────────────────────────
let engine = AVAudioEngine()
let player = AVAudioPlayerNode()
let input = engine.inputNode

/// AEC 开关：默认开。设 VP_OFF=1 可关掉，用于对照实验（判定回声是否真被消除）。
let useVoiceProcessing = (ProcessInfo.processInfo.environment["VP_OFF"] ?? "") != "1"
if useVoiceProcessing {
    do {
        try input.setVoiceProcessingEnabled(true)
    } catch {
        emitError("voice processing 启用失败（回声消除不可用）：\(error)")
        exit(1)
    }
    // ⚠️ 关掉 voice processing 自带的 AGC：实测它把静音期电平从 -54 抬到 -32 dBFS（+22dB），
    //    于是"环境噪声"和"说话"的电平被一起放大，自适应门限反而更不稳、更容易误触发。
    //    关掉后电平才是线性的，VAD 的相对判据才有意义。
    if (ProcessInfo.processInfo.environment["VP_AGC"] ?? "off" == "off") {
        input.isVoiceProcessingAGCEnabled = false
    }
}

let inFormat = input.outputFormat(forBus: 0)
let inChannels = Int(inFormat.channelCount)
let inRate = inFormat.sampleRate

// 中间格式：与输入同采样率的浮点单声道（见踩坑备忘 1）
guard let monoFloat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: inRate, channels: 1, interleaved: false) else {
    emitError("无法构造浮点单声道格式")
    exit(1)
}

engine.attach(player)
let outFormat = engine.outputNode.inputFormat(forBus: 0)
// ⚠️ player 的连接格式必须与**即将 schedule 的 buffer 格式一致**，否则 scheduleBuffer 会抛
//    `required condition is false: _outputFormat.channelCount == buffer.format.channelCount`。
//    所以**不能**写 `format: nil`（那会拿到 mixer 的立体声格式，而 TTS 音频是单声道 32k）。
//    首次连接在首次播放时按文件真实格式建立（见 ensurePlayerFormat）。
var connectedPlayerFormat: AVAudioFormat?

/// 按音频文件的格式把 player 连到 mainMixer；格式变了才重连。
func ensurePlayerFormat(_ format: AVAudioFormat) {
    if let current = connectedPlayerFormat, current.isEqual(format) { return }
    if connectedPlayerFormat != nil {
        engine.disconnectNodeOutput(player)
    }
    engine.connect(player, to: engine.mainMixerNode, format: format)
    connectedPlayerFormat = format
}
engine.connect(engine.mainMixerNode, to: engine.outputNode, format: outFormat)

// ── 播放状态 ────────────────────────────────────────────────────────────────
/// 当前正在播的音频（用于 stop 与 finished 归属）。
var currentAudio: AVAudioFile?
/// 当前播报 id（插件用来对上"哪一句念完了"）。
var currentId: String = ""
/// 最近一次播放过的 id —— 让"已经播完后再收到 stop"也能回一个可对齐的 id。
var lastPlayedId: String = ""
/// 播放中标志。用于自适应底噪的判定：播放时底噪上升是正常的（残余回声），要允许它跟上。
var playing = false
/// 采集回调计数与最近电平 —— 用来证实"麦克风真的在出数据"，否则自适应底噪会一直停在初值。
var tapFrames = 0
var lastLevelDb = -120.0
/// 最近一次播放开始的时刻，用于"播放起点宽限期"。
var lastPlayStartedAt = Date.distantPast
/// 最近一次播放**结束**的时刻（自然播完或被停）。
///
/// 为什么要记它：回声的尾巴落在"播放结束之后"。真机实测到这样的时间线 ——
/// 助手播报 → 播完 → 麦克风把刚播的内容收回去 → 识别成"用户说的话" → **重复注入会话**。
/// 播放期内的严格门限救不了这一段，因为那时播放标志已经回到 false 了。
var lastPlayEndedAt = Date.distantPast

/// 播放结束后的冷却窗（秒）：窗内**保持播放期的严格判定**，把回声尾巴挡在外面。
/// 刻意比"播放起点宽限期"长得多 —— 识别是滞后的，回声可能在播完后一秒才变成文本。
let playbackCooldownSeconds = Double(ProcessInfo.processInfo.environment["VAD_PLAYBACK_COOLDOWN"] ?? "") ?? 1.5

/// 播放指定文件；`id` 仅用于事件里回传。
func play(path: String, id: String) {
    // 先停掉上一条，保证同一时刻只有一个播放源。
    player.stop()
    playing = false
    currentAudio = nil
    currentId = ""

    guard FileManager.default.fileExists(atPath: path) else {
        emitError("音频文件不存在：\(path)")
        return
    }
    guard let file = try? AVAudioFile(forReading: URL(fileURLWithPath: path)) else {
        emitError("无法读取音频：\(path)")
        return
    }
    // 先按文件真实格式接好 player，再读 buffer —— 顺序不能反，否则格式不匹配会崩。
    ensurePlayerFormat(file.processingFormat)
    guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat,
                                       frameCapacity: AVAudioFrameCount(file.length)) else {
        emitError("无法分配音频缓冲：\(path)")
        return
    }
    do {
        try file.read(into: buffer)
    } catch {
        emitError("读取音频失败：\(error)")
        return
    }

    currentAudio = file
    currentId = id
    lastPlayedId = id
    lastPlayStartedAt = Date()
    playing = true
    emit(["ev": "started", "id": id])
    player.scheduleBuffer(buffer, at: nil, options: []) {
        // 播放自然结束（被 stop 打断时不会走到这里）
        let finishedId = currentId
        playing = false
        lastPlayEndedAt = Date()
        currentAudio = nil
        currentId = ""
        emit(["ev": "finished", "id": finishedId])
    }
    if !player.isPlaying { player.play() }
}

/// 停播。`reason` 只用于日志，便于分辨"被用户打断"还是"被新播报顶掉"。
///
/// 无论此刻是否还在播都**必须回一个 `stopped`**：插件靠这个事件对齐"哪一条被中断了"。
/// 若因为"已经播完了"就静默返回，插件侧的打断计数与状态机就会错位。
func stop(reason: String) {
    let stoppedId = playing ? currentId : lastPlayedId
    if playing {
        player.stop()
        playing = false
        lastPlayEndedAt = Date()
        currentAudio = nil
        currentId = ""
    }
    emit(["ev": "stopped", "id": stoppedId, "reason": reason, "wasPlaying": stoppedId == currentId && stoppedId != ""])
}

// ── 采集 + 分句（全双工） ────────────────────────────────────────────────────
//
// 目标格式 16kHz 单声道 PCM16 —— 与 MiniMax ASR 的要求一致。
// ⚠️ 见踩坑备忘 1 与 convertTo16k 的注释：这条路上转换器会静默输出全零，故改手写抽取。

/// 把一路输入 buffer 转成 16kHz 单声道 PCM16 样本。
///
/// ⚠️ **刻意不用 AVAudioConverter**：voice processing 下输入是 5 声道浮点，
///    任何格式不匹配都会让转换器**静默输出全零**（表现为录了 8 秒却识别出空文本 —— 实测踩过两次）。
///    这里改为手写：取 ch0 → 按步长抽样 → 直接写 Int16。零格式协商，行为完全可预测。
/// @param buffer - 采集回调给的输入 buffer。
/// @returns 16kHz PCM16 样本。
func convertTo16k(_ buffer: AVAudioPCMBuffer) -> [Int16] {
    guard let src = buffer.floatChannelData, buffer.frameLength > 0 else { return [] }
    let n = Int(buffer.frameLength)
    let step = inRate / 16000.0            // 48000 → 3
    guard step >= 1 else { return [] }
    var out = [Int16]()
    out.reserveCapacity(Int(Double(n) / step) + 1)
    var i = 0.0
    while Int(i) < n {
        let v = Double(src[0][Int(i)])
        out.append(Int16(max(-1.0, min(1.0, v)) * 32767.0))
        i += step
    }
    return out
}
// ── 全双工：分句 + 云端识别 ──────────────────────────────────────────────────
/// 是否启用全双工语音输入（认领录音、分句、送 ASR）。由插件经 `ASR_ENABLED=1` 下发。
let asrEnabled = (ProcessInfo.processInfo.environment["ASR_ENABLED"] ?? "") == "1"
/// ASR 端点。默认国内端点（实测国际端点不可达）。
let asrEndpoint = ProcessInfo.processInfo.environment["ASR_ENDPOINT"] ?? "https://api.minimax.chat/v1/speech_to_text"
/// 模型名。
let asrModel = ProcessInfo.processInfo.environment["ASR_MODEL"] ?? "asr-1.0"
/// 密钥（插件从仓库外解析后传入）。
let asrKey = ProcessInfo.processInfo.environment["MINIMAX_API_KEY"] ?? ""
/// 语言提示，留空 = 混合语言识别。
let asrLanguage = ProcessInfo.processInfo.environment["ASR_LANGUAGE"] ?? ""
/// 太短的片段不当成一句话（秒）：多半是咳嗽/关门声/单个语气词。
let minUtteranceSeconds = Double(ProcessInfo.processInfo.environment["ASR_MIN_SECONDS"] ?? "") ?? 0.35
/// 单句最长（秒）。超过就强制切句送去识别，避免迟迟拿不到文本（延迟上界）。
let maxUtteranceSeconds = Double(ProcessInfo.processInfo.environment["ASR_MAX_SECONDS"] ?? "") ?? 12.0
/// 句子落盘目录（本地识别用）。给了就把每句话写成 WAV 文件并报路径，
/// 由插件侧读文件调本地 SenseVoice；留空则退回"内核直连云端 ASR"。
let utteranceDir = ProcessInfo.processInfo.environment["ASR_UTTERANCE_DIR"] ?? ""
/// 落盘计数器，用于生成不重名的文件名。
var utteranceSeq = 0
/// 落盘时是否做峰值归一化（本地识别同样受益于电平拉齐）。
let normalizeOnWrite = (ProcessInfo.processInfo.environment["ASR_NO_NORMALIZE"] ?? "") != "1"
/// 录音前预滚时长（秒）：把"开口前"的一小段也带上，避免掐掉字头。
let prerollSeconds = Double(ProcessInfo.processInfo.environment["ASR_PREROLL_SECONDS"] ?? "") ?? 0.25

/// 预滚环形缓冲（16kHz 样本）。
var preroll = [Int16]()
/// 当前这句已累积的 16kHz 样本。
var utterance = [Int16]()
/// 是否正在认领录音。
var capturing = false
/// 当前这句话是否起于"播放冷却窗内"（= 大概率是回声尾巴，不是你在说话）。
var capturingInCooldown = false
/// 串行队列：ASR 的网络等待绝不能阻塞音频/命令线程。
let asrQueue = DispatchQueue(label: "dsh-stage-speak.asr")
/// 在飞的识别任务数（用于 stats 与优雅退出）。
var asrInFlight = 0
/// 已完成识别的句数。
var asrDone = 0

/// 把当前累积的录音送去识别；识别结果以 `utterance` 事件回吐。
/// @param reason - `silence`（静音判句）或 `maxlen`（超长强切），仅用于日志与事件。
func flushUtterance(reason: String) {
    guard asrEnabled else { return }
    let samples = utterance
    let inCooldownAtCapture = capturingInCooldown
    capturingInCooldown = false
    utterance.removeAll(keepingCapacity: true)
    let seconds = Double(samples.count) / 16000.0
    guard seconds >= minUtteranceSeconds else {
        emit(["ev": "utterance-skipped", "reason": "too-short", "seconds": (seconds * 100) / 100])
        return
    }
    // 本地识别路径：把这句话写成 WAV 文件并报路径，由插件侧读文件调本地 SenseVoice。
    if !utteranceDir.isEmpty {
        asrInFlight += 1
        asrQueue.async {
            utteranceSeq += 1
            let name = String(format: "utt-%06d.wav", utteranceSeq)
            let path = (utteranceDir as NSString).appendingPathComponent(name)
            let written = normalizeOnWrite ? normalizeForAsr(samples) : samples
            do {
                try wavData(samples: written).write(to: URL(fileURLWithPath: path))
                asrInFlight -= 1
                asrDone += 1
                emit(["ev": "utterance-file", "path": path, "id": name,
                      "seconds": (seconds * 100).rounded() / 100, "reason": reason,
                      "afterPlayback": inCooldownAtCapture])
            } catch {
                asrInFlight -= 1
                emitError("句子落盘失败：\(error)")
                emit(["ev": "utterance-failed", "reason": reason, "message": "落盘失败：\(error)"])
            }
        }
        return
    }
    asrInFlight += 1
    asrQueue.async {
        let started = Date()
        var localSamples = samples
        let result = transcribe(samples: localSamples, seconds: seconds)
        localSamples.removeAll()
        let ms = Int(Date().timeIntervalSince(started) * 1000)
        asrInFlight -= 1
        asrDone += 1
        switch result {
        case .success(let text):
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                emit(["ev": "utterance-skipped", "reason": "empty-text", "ms": ms, "seconds": (seconds * 100) / 100])
            } else {
                emit(["ev": "utterance", "text": trimmed, "ms": ms,
                      "seconds": (seconds * 100) / 100, "reason": reason])
            }
        case .failure(let error):
            emitError("识别失败（\(reason)）：\(error.message)")
            emit(["ev": "utterance-failed", "reason": reason, "message": error.message, "ms": ms])
        }
    }
}

/// 把样本按峰值归一化到目标电平，供识别使用。
///
/// 增益有上限，避免把纯噪声也放大成"声音"；全静音输入原样返回。
/// @param samples - 16kHz PCM16 样本。
/// @returns 归一化后的样本（新数组）。
func normalizeForAsr(_ samples: [Int16]) -> [Int16] {
    var peak = 0
    for s in samples { let a = abs(Int(s)); if a > peak { peak = a } }
    guard peak > 0 else { return samples }
    // 目标峰值 = full scale 的 70%；增益封顶 20 倍（约 +26dB），再高就是把噪声当信号
    let target = 0.70 * 32767.0
    let gain = min(target / Double(peak), 20.0)
    guard gain > 1.05 else { return samples }
    var out = [Int16]()
    out.reserveCapacity(samples.count)
    for s in samples {
        let v = Double(s) * gain
        out.append(Int16(max(-32768.0, min(32767.0, v))))
    }
    return out
}

/// 把 16kHz 单声道 PCM16 样本封装成标准 WAV（44 字节头）。
/// @param samples - PCM16 样本。
/// @returns WAV 字节。
func wavData(samples: [Int16]) -> Data {
    var wav = Data()
    let dataBytes = samples.count * 2
    func le32(_ v: UInt32) -> Data { withUnsafeBytes(of: v.littleEndian) { Data($0) } }
    func le16(_ v: UInt16) -> Data { withUnsafeBytes(of: v.littleEndian) { Data($0) } }
    wav.append("RIFF".data(using: .ascii)!); wav.append(le32(UInt32(36 + dataBytes)))
    wav.append("WAVE".data(using: .ascii)!)
    wav.append("fmt ".data(using: .ascii)!); wav.append(le32(16)); wav.append(le16(1)); wav.append(le16(1))
    wav.append(le32(16000)); wav.append(le32(16000 * 2)); wav.append(le16(2)); wav.append(le16(16))
    wav.append("data".data(using: .ascii)!); wav.append(le32(UInt32(dataBytes)))
    var pcm = Data(capacity: dataBytes)
    for s in samples { withUnsafeBytes(of: s.littleEndian) { pcm.append(contentsOf: $0) } }
    wav.append(pcm)
    return wav
}

/// 同步调一次 MiniMax ASR（在 asrQueue 上执行，不阻塞音频线程）。
/// @param samples - 16kHz 单声道 PCM16。
/// @param seconds - 音频时长（用于日志）。
/// @returns 识别文本或错误信息。
/// ASR 失败原因（String 不满足 Error，故单独包一层）。
struct AsrError: Error { let message: String }

func transcribe(samples: [Int16], seconds: Double) -> Result<String, AsrError> {
    guard !asrKey.isEmpty else { return .failure(AsrError(message: "没有 API key（插件未传入 MINIMAX_API_KEY）")) }
    // 电平归一化：只作用于**送识别**的这份拷贝，VAD 用的原始电平不受影响。
    // 为什么必须做：实测本机麦克风（关掉 voice processing 的 AGC 后）说话峰值只有 ~3600/32767
    // ≈ -19dBFS 甚至更低，识别器会当成静音返回空文本。归一化把它拉到正常动态范围。
    let normalized = normalizeForAsr(samples)
    guard let url = URL(string: asrEndpoint) else { return .failure(AsrError(message: "端点非法：\(asrEndpoint)")) }

    let wav = wavData(samples: samples)

    // multipart/form-data 手工拼装（只有两个文本字段 + 一个文件字段，不值得引依赖）
    let boundary = "----dshStageSpeak\(UInt32.random(in: 100000...999999))"
    var body = Data()
    func field(_ name: String, _ value: String) {
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n".data(using: .utf8)!)
        body.append("\(value)\r\n".data(using: .utf8)!)
    }
    field("model", asrModel)
    body.append("--\(boundary)\r\n".data(using: .utf8)!)
    body.append("Content-Disposition: form-data; name=\"file\"; filename=\"utterance.wav\"\r\n".data(using: .utf8)!)
    body.append("Content-Type: audio/wav\r\n\r\n".data(using: .utf8)!)
    body.append(wav)
    body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)

    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("Bearer \(asrKey)", forHTTPHeaderField: "Authorization")
    request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
    if !asrLanguage.isEmpty { request.setValue(asrLanguage, forHTTPHeaderField: "language") }
    request.httpBody = body
    // 超时按音频时长给余量：短句 15s 足够，长句放宽
    request.timeoutInterval = max(15.0, seconds * 2 + 10)

    let semaphore = DispatchSemaphore(value: 0)
    var result: Result<String, AsrError> = .failure(AsrError(message: "未执行"))
    let task = URLSession.shared.dataTask(with: request) { data, response, error in
        defer { semaphore.signal() }
        if let error = error {
            result = .failure(AsrError(message: error.localizedDescription))
            return
        }
        guard let data = data else { result = .failure(AsrError(message: "空响应")); return }
        if let http = response as? HTTPURLResponse, http.statusCode != 200 {
            let snippet = String(data: data, encoding: .utf8)?.prefix(200) ?? ""
            result = .failure(AsrError(message: "HTTP \(http.statusCode)：\(snippet)"))
            return
        }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            result = .failure(AsrError(message: "响应不是 JSON"))
            return
        }
        if let text = object["text"] as? String {
            result = .success(text)
            return
        }
        let snippet = String(data: data, encoding: .utf8)?.prefix(200) ?? ""
        result = .failure(AsrError(message: "响应里没有 text：\(snippet)"))
    }
    task.resume()
    semaphore.wait()
    return result
}

/// 自适应底噪（dBFS）。初值取一个保守的低值，启动后很快会爬升到真实底噪。
// ── VAD：端点检测（判断"你在说话"与"说完了"） ───────────────────────────────
var noiseFloorDb: Double = -70.0
/// 是否已越过触发门限（正在"说话"状态）。
var speaking = false
/// 连续超阈/低阈帧计数。
var aboveCount = 0
var belowCount = 0
/// 引擎启动时刻，用于计算校准期。
let startedAt = Date()
/// 是否仍在校准期。
var calibrating = true

input.installTap(onBus: 0, bufferSize: 1024, format: inFormat) { buffer, _ in
    guard let src = buffer.floatChannelData, buffer.frameLength > 0 else { return }
    let n = Int(buffer.frameLength)

    // 抽 ch0 算能量（见踩坑备忘 1：多声道内容相同，取一路即可）
    var sum = 0.0
    for i in 0..<n {
        let v = Double(src[0][i])
        sum += v * v
    }
    let rms = (sum / Double(n)).squareRoot()
    let levelDb = rms > 0 ? 20 * log10(rms) : -120.0
    tapFrames += 1
    lastLevelDb = levelDb

    // 校准期：只测底噪、绝不触发（详见参数注释）
    let elapsed = Date().timeIntervalSince(startedAt)
    if calibrating {
        noiseFloorDb = noiseFloorDb * (1 - floorAdaptCalibrating) + levelDb * floorAdaptCalibrating
        if elapsed >= calibrateSeconds {
            if noiseFloorDb < absoluteFloorDb { noiseFloorDb = absoluteFloorDb }
            calibrating = false
            emit(["ev": "calibrated", "noiseFloorDb": (noiseFloorDb * 10).rounded() / 10, "lastLevelDb": (levelDb * 10).rounded() / 10])
        }
        return
    }

    // 底噪自适应：说话时用更慢的系数（仍要动，否则误触发后自锁死；见参数注释）
    let adapt = speaking ? floorAdaptWhileSpeaking : floorAdapt
    noiseFloorDb = noiseFloorDb * (1 - adapt) + levelDb * adapt
    if noiseFloorDb < absoluteFloorDb { noiseFloorDb = absoluteFloorDb }

    // 「按播放态处理」的两个条件：
    //   a) 正在播；或 b) 刚播完、仍在冷却窗内 —— 后者专治"回声尾巴在播完后才被识别"。
    let sincePlayEnded = Date().timeIntervalSince(lastPlayEndedAt)
    let inPlaybackCooldown = !playing && sincePlayEnded < playbackCooldownSeconds
    let treatAsPlaying = playing || inPlaybackCooldown
    // 播放起点宽限期：刚开始播的一小段绝不触发（等电平/回声稳定）
    let inGrace = playing && Date().timeIntervalSince(lastPlayStartedAt) < playingGraceSeconds
    if inGrace {
        aboveCount = 0
        return
    }
    let overDb = treatAsPlaying ? speechOverFloorDbPlaying : speechOverFloorDb
    let triggerDb = max(noiseFloorDb + overDb, absoluteTriggerDb)
    let releaseDb = noiseFloorDb + releaseOverFloorDb

    if levelDb > triggerDb {
        aboveCount += 1
        belowCount = 0
        if !speaking && aboveCount >= attackFrames {
            speaking = true
            emit(["ev": "voice", "level": (levelDb * 10).rounded() / 10])
            // 全双工：开始认领这句话。先补上预滚，避免掐掉字头。
            if asrEnabled {
                capturing = true
                capturingInCooldown = inPlaybackCooldown
                utterance = preroll
            }
        }
    } else {
        belowCount += 1
        aboveCount = 0
        if speaking && levelDb < releaseDb {
            if belowCount >= releaseFrames {
                speaking = false
                emit(["ev": "silence", "level": (levelDb * 10).rounded() / 10])
                // 全双工：静音判句 → 送去识别
                if capturing {
                    capturing = false
                    flushUtterance(reason: "silence")
                }
            }
        } else if speaking {
            // 还没低到释放线，重置计数：句中自然停顿不该结束一句话
            belowCount = 0
        }
    }

    // 全双工：把这一帧灌进预滚缓冲、（若在认领）当前句缓冲。
    // 放在 VAD 判定之后，保证"刚触发的那一帧"不会漏进上一句。
    if asrEnabled {
        let pcm = convertTo16k(buffer)
        if !pcm.isEmpty {
            if capturing {
                utterance.append(contentsOf: pcm)
                // 超长强切：给"迟迟不静音"的长句一个延迟上界
                if Double(utterance.count) / 16000.0 >= maxUtteranceSeconds {
                    flushUtterance(reason: "maxlen")
                    utterance = []   // 继续认领：后续音频归下一句，不丢内容
                }
            } else if !speaking {
                let maxPreroll = Int(prerollSeconds * 16000)
                if maxPreroll > 0 {
                    preroll.append(contentsOf: pcm)
                    if preroll.count > maxPreroll {
                        preroll.removeFirst(preroll.count - maxPreroll)
                    }
                }
            }
        }
    }
}

engine.prepare()
do {
    try engine.start()
} catch {
    emitError("音频引擎启动失败：\(error)")
    exit(1)
}

emit([
    "ev": "ready",
    "sampleRate": inRate,
    "channels": inChannels,
    "speechOverFloorDb": speechOverFloorDb,
    "releaseOverFloorDb": releaseOverFloorDb,
    "tapInstalled": true,
    "asrEnabled": asrEnabled,
])

// ── 自测模式：录固定时长 → 直接送识别 → 打印结果 → 退出 ─────────────────────
// 用途：把"录音 + 云端识别"这条链路单独验证，不必依赖整套插件。
// 用法：ASR_ENABLED=1 MINIMAX_API_KEY=... ASR_TEST_SECONDS=6 ./engine/audio-core
//
// ⚠️ 教训：这里**绝不能**用 Thread.sleep 或 RunLoop.main.run(until:) 来"等 6 秒"。
//    实测两者都会把采集回调饿死 —— 6 秒只采到 3.15 秒、且整体延后 11 秒才动。
//    正确做法：主线程只跑事件循环，用定时器推进"录制结束 → 等识别 → 退出"的状态机。
if let testSecondsRaw = ProcessInfo.processInfo.environment["ASR_TEST_SECONDS"],
   let testSeconds = Double(testSecondsRaw), testSeconds > 0 {
    if !asrEnabled {
        emitError("ASR_TEST_SECONDS 需要同时设 ASR_ENABLED=1")
        exit(2)
    }
    emit(["ev": "asr-test-begin", "seconds": testSeconds])
    /// 状态机：waiting-calibration → recording → waiting-asr → done
    var testPhase = "waiting-calibration"
    var testDeadline = Date().addingTimeInterval(calibrateSeconds + 0.4)
    let testTimer = DispatchSource.makeTimerSource(queue: DispatchQueue.global())
    testTimer.schedule(deadline: .now() + 0.1, repeating: 0.1)
    testTimer.setEventHandler {
        switch testPhase {
        case "waiting-calibration":
            if !calibrating || Date() >= testDeadline {
                testPhase = "recording"
                capturing = true
                utterance = []
                testDeadline = Date().addingTimeInterval(testSeconds)
                emit(["ev": "asr-test-recording", "seconds": testSeconds])
            }
        case "recording":
            if Date() >= testDeadline {
                capturing = false
                let peak = utterance.reduce(0) { max($0, abs(Int($1))) }
                emit(["ev": "asr-test-recorded", "samples": utterance.count,
                      "seconds": (Double(utterance.count) / 16000.0 * 100).rounded() / 100,
                      "peakInt16": peak])
                flushUtterance(reason: "asr-test")
                testPhase = "waiting-asr"
                testDeadline = Date().addingTimeInterval(30)
            }
        case "waiting-asr":
            if asrInFlight == 0 || Date() >= testDeadline {
                emit(["ev": "asr-test-end", "done": asrDone])
                testTimer.cancel()
                engine.stop()
                exit(0)
            }
        default:
            break
        }
    }
    testTimer.resume()
    // 主线程只跑事件循环，让采集回调畅通无阻
    RunLoop.main.run()
    exit(0)
}

// ── 自测：直接识别一个 WAV 文件（不碰麦克风）────────────────────────────────
// 用法：ASR_ENABLED=1 MINIMAX_API_KEY=... ASR_TEST_FILE=/path/x.wav ./engine/audio-core
// 这一路把"WAV 封装 + ASR 请求/解析"单独隔离出来验证，排除声学环境的干扰。
if let testFile = ProcessInfo.processInfo.environment["ASR_TEST_FILE"], !testFile.isEmpty {
    if !asrEnabled {
        emitError("ASR_TEST_FILE 需要同时设 ASR_ENABLED=1")
        exit(2)
    }
    guard let raw = FileManager.default.contents(atPath: testFile), raw.count > 44 else {
        emitError("读不到 WAV 文件：\(testFile)")
        exit(2)
    }
    // 只接受 16kHz 单声道 PCM16（44 字节标准头）：按头部偏移取样本，不做格式转换。
    let sampleBytes = raw.count - 44
    var samples = [Int16]()
    samples.reserveCapacity(sampleBytes / 2)
    var offset = 44
    while offset + 1 < raw.count {
        let lo = UInt16(raw[offset])
        let hi = UInt16(raw[offset + 1]) << 8
        samples.append(Int16(bitPattern: lo | hi))
        offset += 2
    }
    let seconds = Double(samples.count) / 16000.0
    emit(["ev": "asr-file-begin", "path": testFile, "samples": samples.count, "seconds": (seconds * 100).rounded() / 100])
    let started = Date()
    switch transcribe(samples: samples, seconds: seconds) {
    case .success(let text):
        emit(["ev": "asr-file-text", "text": text, "ms": Int(Date().timeIntervalSince(started) * 1000)])
    case .failure(let error):
        emit(["ev": "asr-file-failed", "message": error.message, "ms": Int(Date().timeIntervalSince(started) * 1000)])
    }
    exit(0)
}

// 周期心跳：每 2 秒报一次采集状态。与命令解耦，用于证实"麦克风真的在出数"。
let heartbeat = DispatchSource.makeTimerSource(queue: DispatchQueue.global())
heartbeat.schedule(deadline: .now() + 2, repeating: 2)
heartbeat.setEventHandler {
    emit(["ev": "heartbeat", "tapFrames": tapFrames,
          "lastLevelDb": (lastLevelDb * 10).rounded() / 10,
          "noiseFloorDb": (noiseFloorDb * 10).rounded() / 10,
          "speaking": speaking, "playing": playing])
}
heartbeat.resume()

// ── 命令循环（事件驱动，**不要用 readLine 阻塞**）─────────────────────────────
//
// ⚠️ 教训（实测踩过）：早期版本用 `while let line = readLine(...)` 读 stdin。
//    readLine 会**阻塞主线程**，而采集回调与各定时器都指望主线程把 RunLoop 跑起来 ——
//    结果是整个内核被"饿死"：自测模式录 6 秒只拿到 3.15 秒，事件全部堆到最后才吐出，
//    一次测试跑了 297 秒。**生产里同样会踩**（开口打断、分句状态机都会失灵）。
//    正确做法：用 DispatchSourceRead 把 stdin 变成回调，主线程只跑 RunLoop。
/// 逐行解析 stdin 递来的命令。
/// 把一段（可能含多行的）文本按行切分并逐条执行。
/// @param text - 新读到的文本片段。
func handleInput(_ text: String) {
    inputBuffer += text
    while let newline = inputBuffer.firstIndex(of: "\n") {
        let line = String(inputBuffer[inputBuffer.startIndex..<newline])
        inputBuffer = String(inputBuffer[inputBuffer.index(after: newline)...])
        handleCommandLine(line)
    }
}

/// 执行一条命令。
/// @param line - 一行 JSON。
func handleCommandLine(_ line: String) {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return }
    guard let data = trimmed.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let cmd = object["cmd"] as? String else {
        emitError("无法解析命令：\(trimmed.prefix(120))")
        return
    }
    switch cmd {
    case "play":
        play(path: object["path"] as? String ?? "", id: object["id"] as? String ?? "")
    case "stop":
        stop(reason: object["reason"] as? String ?? "requested")
    case "ping":
        emit(["ev": "pong", "playing": playing,
              "noiseFloorDb": (noiseFloorDb * 10).rounded() / 10,
              "lastLevelDb": (lastLevelDb * 10).rounded() / 10,
              "tapFrames": tapFrames, "speaking": speaking,
              "asrEnabled": asrEnabled, "asrInFlight": asrInFlight, "asrDone": asrDone])
    case "quit":
        player.stop()
        engine.stop()
        exit(0)
    default:
        emitError("未知命令：\(cmd)")
    }
}

/// stdin 缓冲（跨读取片段拼接用）。
var inputBuffer = ""
/// stdin 的读事件源；持有它，别让它被释放。
let stdinSource = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: DispatchQueue.global())
stdinSource.setEventHandler {
    var chunk = [UInt8](repeating: 0, count: 4096)
    let read = read(STDIN_FILENO, &chunk, chunk.count)
    if read <= 0 {
        // stdin 关闭 = 父进程没了，跟着退出，避免留下孤儿进程占着麦克风。
        player.stop()
        engine.stop()
        exit(0)
    }
    if let text = String(bytes: chunk[0..<read], encoding: .utf8) {
        handleInput(text)
    }
}
stdinSource.resume()

// 主线程只跑事件循环：让采集回调、心跳、分句状态机都畅通无阻。
RunLoop.main.run()

