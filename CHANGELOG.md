# CHANGELOG

## V1.8.3 — 2026-10-02 · 收掉两条已知边界：多备用音色 + 内核自动构建

### 1. ≥3 会话不再撞音色（`voiceAlt` 可填多个）

**问题**：原来只支持"主音色 + 一个备用"，第 3 个会话会拿到和第 2 个相同的音色 ——
多会话并行时又分不清谁在说了（这正是 v1.5.0 当初要解决的问题）。

**修法**：`voiceAlt` 接受**逗号分隔的列表**（如 `A, B, C`）。
- 单个值 = 老行为，**完全向后兼容**；
- 分配规则不变（第一个活跃会话拿主音色，主音色空出来就归还），只是备用音色按"当前未被占用的"挑；
- 用满之后回绕复用 —— 不再有更好的办法，但那只是音色重复，不影响功能。

面板提示同步更新，说明可以填多个。

### 2. 内核首次使用时自动构建

**问题**：`engine/audio-core` 是编译产物、**不入库**（平台相关）。从 git 克隆出来的安装包里没有它，
于是双工档静默不可用，只有一条 warn 让人自己回去读日志找构建脚本。

**修法**：内核缺失时**后台**触发一次 `engine/build-audio-core.sh`。三个刻意的设计：
1. **不阻塞** —— detached 子进程，本次仍优雅降级（播报照旧走 wrapper 自播），编好下次生效。
   同步等编译器会把 `apply()` 拖成秒级。
2. **不报错** —— 缺 Swift 工具链的机器上，双工不可用但播报必须正常。
3. **只试一次** —— 失败后不再反复敲。

实测：移走内核后触发，**4.0 秒**编回（140992 字节），协议冒烟照常通过。

### 顺带修掉一处自己引入的测试污染

`buildAttempted` 最初写成**模块级**标志，结果前一条用例把它置位后，后一条用例再也不 warn，
表现为"单独跑过、整个套件跑挂"的假失败。已把状态挪进**工厂内部**（每个插件实例一份）——
语义也更对："每个实例只试一次"，而不是进程级。

### 验证

- `node test/offline.mjs` **135 / 135**（V1.8.2 的 132 条全过 + 新增 3 条：两音色分配 + 自动构建）
- `node test/client-harness.mjs` 通过（面板 38 字段）
- `node test/smoke-audio-core.mjs` 通过
- `scripts/check-secrets.mjs` 干净；`node --check` 全过
- 自动构建**真机验证**：移走内核 → 触发 → 4.0s 编回 → 冒烟通过

## V1.8.2 — 2026-10-02 · 修「自己听见自己」：防自注入两层防御

**来源**：全双工真机首次跑通时立刻暴露（journal 有完整时间线）：

```
07:03:45  你说「我已经重启了。」      → 触发 kickoff
07:03:47  助手播报「明白，我先确认重启后的当前状态…」
07:03:50  duplex-injected  steer  我已经重启了。我已经重启了。   ← 助手自己的播报被收回去了
```

即：**助手播报 → 麦克风收回去 → 识别成"用户说的话" → 重复注入会话**。

### 根因

内核的严格门限（`VAD_OVER_DB_PLAYING=14`）与播放起点宽限期（0.4s）**只在播放期间生效**。
而识别是**滞后**的：回声尾巴落在播放结束之后，那时播放标志已回到 false、门限降回安静档（+9dB），
于是被当成用户说话。这正是"没有 ASR 的半双工档无法根除误触发"那个固有极限的**必然残留**。

### 修法：两层防御（缺一不可）

| 层 | 位置 | 做法 |
|:--|:--|:--|
| 1 | 内核 `audio-core.swift` | 新增**播放结束冷却窗**（`VAD_PLAYBACK_COOLDOWN`，默认 **1.5s**）：窗内**维持播放期的严格判定**。并给起于窗内的句子打 `afterPlayback: true` 标记 |
| 2 | 插件 `lib/duplex.js` | **与"最近念过的文本"做相似度比对**（字符二元组 Dice 系数，阈值 0.72，窗口 20s）：识别结果字面上就是刚念的内容 → 丢弃 |

第 2 层的**关键设计**：只跟 20 秒内念过的比。更早的内容被用户复述是合理行为，不该误杀（有用例③守着）。
取不到比对素材时**放行**——宁可漏挡一次回声，也不要误杀用户真实说的话。

新增开关 `duplexEchoGuard`（默认开，已在面板）：关掉时**两层一起关**（否则"关了还在拦"，用户会以为开关坏了）。

### 验证（新增 5 条用例，全部为真机场景复刻）

```
✓ 防自注入①：识别结果与最近播报高度重合 → 不注入（复刻 07:03:50 那条真机日志）
✓ 防自注入②：用户真实的话不受影响（相似度不足则照常注入）
✓ 防自注入③：与较早（40s 前）的播报重合 → 不拦，避免误杀用户复述
✓ 防自注入④：起于播放冷却窗内的句子直接丢弃（afterPlayback 标记）
✓ 防自注入⑤：duplexEchoGuard=false 时两层一起关
```

`node test/offline.mjs` **132 / 132**（V1.8.1 的 127 条全过 + 新增 5）；
`client-harness` 通过（面板 **38** 字段）；`smoke-audio-core` 通过；`check-secrets` 干净；`node --check` 全过。

### 真机验收（2026-10-02，用户确认）

用户重启后连说多轮，**全双工正常、不再重复注入**。journal 同时留痕：

```
duplex-injected  steer  我先暂停一下。          ← 识别准确
duplex-injected  steer  嗯继续。你继续。
duplex-mode-changed  from=full|kernel=1|duplex=1 to=off|kernel=0|duplex=0 trigger=volatile-update
```

最后一行同时证明**拨档位即时生效**（不必重启宿主）也通过真机验收。

## V1.8.1 — 2026-10-02 · 拨档位当场生效（配置是原地热更新，插件只读了一次）

**来源**：真机缺陷 —— 用户重启宿主后（journal `ready … duplex=off`）在面板把「双工档位」从
「原始」拨到「全双工」并保存：`cordis.patch.yml` 里**确实写入了 `mode: full`**，
但**没有内核进程**、journal 里也再没有 `duplex=*` 行 —— 双工根本没起来，必须重启宿主才行。

### 根因（源码逐行核对，不是推测）

面板保存**不是**"改配置 → 重挂载插件"，而是走了 `cordis-plugin-loader` 的 **volatile 快路径**：

```js
// cordis-plugin-loader/lib/index.js —— Entry._commitVolatile()
const refs = volatileEntries(fiber.config);          // ← 从 fiber.config 里取出 volatile 访问器引用
const candidate = resolveConfig(fiber.runtime, ...); // 归一化后的候选配置
const paths = refs.flatMap(({ path, ref }) => {
  const source = path.reduce((value, key) => Reflect.get(value, key), candidate);
  if (deepEqual(ref.get(), source.get(), true)) return [];
  updateVolatile(ref, source);                       // ← 把新值**原地写进活访问器**
  return [path];
});
if (!paths.length) return true;                      // → return true
// 调用方：const pending = volatileOnly && this._commitVolatile() ? [] : changes;
//         if (!pending.length && !force) return;    // ← 直接返回：**不重挂载、不重跑 apply**
```

而 `lib/index.js` 的 `apply()` 在启动时把 `mode` 读了一次就算好了 `wantBargeIn` / `wantDuplex`，
之后再也不看 —— 所以拨档位对运行中的插件毫无作用。
（`mode` / `bargeInEnabled` / `duplexEnabled` 全都是 `.volatile()` 字段，正好走这条快路径。）

### 改动

| # | 文件 | 改动 |
|:--|:--|:--|
| 1 | `lib/index.js` | ① 新增 `liveConfigSource()`：优先读 `ctx.fiber?.config`（= 面板保存时被原地改写的那个活对象），取不到（非 Loader 挂载 / 没有 fiber / 代理抛错）**回落 `apply` 时的原始入参**；两条路都仍经 `resolveConfig()` 归一化，不绕过配置契约。② 「档位 → 要不要内核 / 要不要全双工」抽成纯函数 `pathState()`，通路建立/拆除改成**可重入**的 `buildPath()` / `teardownPath()`（复用既有 `duplex.dispose()` / `audioCore.dispose()` / `engine.dispose()`）。③ 新增差分刷新 `refreshPath(trigger)`：只有通路指纹（`mode` / `bargeInEnabled` / `duplexEnabled`）变化才拆旧建新；只改 `duplexLanguage` / `duplexInjectMode` 时**只重建 duplex**（内核不重启 —— 免得白花 2–3.5 秒重新起麦+校准）。④ 新增 `modeWatchMs` 低频看门狗（默认 1500ms，`ctx.effect` + `setInterval`，随插件卸载清掉；置 0 = 关闭）。⑤ 同时订阅 `loader/volatile-update`（见下）走同一套幂等差分。⑥ 每次刷新把归一化后的配置**就地** `Object.assign` 回 `config`，于是面板的"改配置热生效"对**所有**字段都成立（此前只有启动时读的那一次）。⑦ 判定写 journal：`duplex-mode-changed from=… to=… trigger=…`、`duplex-params-changed …`。 |
| 2 | `test/offline.mjs` | 新增 9 条（8 条热更新 + 1 条节拍钳制）：见"验证"。`fakeCtx` 之外的 `hotCtx()` 会挂上 `ctx.fiber.config` 活配置；`liveCfg()` / `watchKernelCommands()` / `tempJournal()` 为新增小工具。 |
| 3 | `CHANGELOG.md` | 本条。 |
| 4 | 版本 | 1.8.0 → **1.8.1**（`package.json` 由 Lead 统一处理）。 |

**未改**：`lib/audio-core.js`、`lib/duplex.js`、`lib/client.js`、`engine/*`、`package.json` 一行未动
（重入只需要在 `index.js` 里换引用，不需要动那两个模块）。

### 为什么是"看门狗 + 事件"两条腿（对根因说明的一处修正）

准确说：**没有任何"配置已变更"的公开事件可订阅** —— `internal/config` 只是解析期 waterfall
（谁都能挂，但那是配置解析路径本身），`internal/update` 只在整插件重载时走。
**但是** volatile 快路径在写完之后会自己发一个 `loader/volatile-update`（按 fiber 过滤后送达本插件）。

所以落地为：
- **看门狗是保证**（1.5s 差分轮询）—— 不依赖任何内部事件，DSH 将来改了内部行为也照样生效；
- **事件是加速** —— 收到就地比对，切档位是"立刻"而不是"最多 1.5 秒后"。
两条走**同一个** `refreshPath()`，指纹差分是幂等的，重复触发无害。
两者都失效时最坏退化成"启动时判定一次"（= 修复前的行为），**播报始终不受影响**。

### 验证（全部本机实跑）

- `node test/offline.mjs` → **127 / 127**（V1.8.0 基线 118 条全过 + 新增 9 条）
- `node test/client-harness.mjs` → 通过（字段仍是 37 个：`modeWatchMs` 有意不加 `.volatile()`，不进面板）
- `node scripts/check-secrets.mjs` → 干净；`node --check` 全部文件 OK
- **真机机制探针（真 cordis + loader 用的同一对 `volatileEntries`/`updateVolatile`）**：
  把插件挂到**真 cordis Context** 上，用 `updateVolatile` 原地改写活访问器（= 面板保存做的事），
  **不重挂载、不重跑 apply**：

  ```
  fiber.config 是对象: true | 键数: 43
  fiber.config.mode: {} | 是访问器: true          ← 活配置确实是访问器对象
  启动档位 mode = off | 启动时内核数 = 0 (off 档应为 0)
  —— ① 事件路径（复刻 loader 的 loader/volatile-update 发送方式）——
  updateVolatile 改动的路径: [["mode"]] | 改完 fiber.config.mode = full
  300ms 后内核数 = 1 | ASR_ENABLED = 1           ← 事件那条路真的通（看门狗默认 1.5s）
  —— ② 看门狗路径（只改活配置、不发事件）——
  只改活配置、不发事件：mode = full
  2.2s 后内核数 = 2（+1）| ASR_ENABLED = 1        ← 没有任何事件，靠差分轮询也起来了
  —— journal 留痕 ——
      duplex-mode-changed from=off|kernel=0|duplex=0 to=full|kernel=1|duplex=1 trigger=volatile-update
      duplex-mode-changed from=full|kernel=1|duplex=1 to=off|kernel=0|duplex=0 trigger=volatile-update
      duplex-mode-changed from=off|kernel=0|duplex=0 to=full|kernel=1|duplex=1 trigger=watchdog
  ```

  这一条等价于"面板保存"的完整链路（真 cordis、真访问器、真热更新函数），只差宿主重启那一步。
- 新增的 9 条离线用例：
  ① 看门狗 off→full → 起内核且带 `ASR_ENABLED`/`ASR_UTTERANCE_DIR`
  ② full→off → 旧内核收到 `quit`、不再有第二个内核，且播报回到 wrapper 自播
  ③ 只改非关键键（`graceMs`）→ **不**重建通路（journal 一个字不多、内核一条命令不收），但新值当场生效
  ④ `ctx.fiber` 不存在 → 不抛错、退回"启动时判定一次"
  ⑤ `modeWatchMs: 0`（关掉看门狗）时，`loader/volatile-update` 事件仍能即时切档
  ⑥ 活配置是**访问器形状**（DSH 的真实形状）时同样能发现变化
  ⑦ 只改 `duplexLanguage` → 内核不重启，且同一句仍**只**被处理/注入一次（证明没重复挂 `utterance-file` 监听）
  ⑧ 来回切三轮不泄漏内核：恰好 2 个内核、被切走的那个收到 `quit`、当前这个一条命令都不收
  ⑨ `modeWatchMs` 默认 1500 / 0=关闭 / 非 0 钳到 50ms 下限

### 仍未验证（如实记录）

- ~~**真机重启后的面板实测**没做~~ → **已完成**（2026-10-02）：真机拨档位当场生效，
  journal 出现 `duplex-mode-changed … trigger=volatile-update`。
- `modeWatchMs` 默认 1.5s ⇒ 关掉事件路径时切档位最坏延迟 1.5s；有事件时是即时的。
- 面板点「保存」若同时改了 volatile 与非 volatile 字段，loader 会走**整插件重载**（`apply` 重跑），
  这条路径本来就正常，本次没动它。


## V1.8.0 — 2026-10-02 · 全双工接线（`mode: 'full'`：开口 → 让路 → 本地识别 → 注入当前回合）

**来源**：用户拍板 ——「你开口说话 → 播报停下 → **本地识别** → 文本作为用户消息**插进当前回合**」，
识别引擎用**本地 SenseVoice**（`ctx.speechToText`），注入方式用 **steer**。
本次只做**接线**：内核（AEC + VAD + 分句落盘）与本地识别服务都已就绪并单独验证过，
`engine/audio-core.swift` / `engine/audio-core` **一行未动**。

### 改动

| # | 文件 | 改动 |
|:--|:--|:--|
| 1 | `lib/audio-core.js` | ① `utterance-file` 事件**显式派发**并计数（`stats().utterances`），新增命名回调 `onUtteranceFile`。⚠️ 事件名到回调名改为**显式映射表** —— `utterance-file` 带连字符，靠"首字母大写"拼会得到 `onUtterance-file`。② `config.asrEnabled === true` 时下发 `ASR_ENABLED=1` + `ASR_UTTERANCE_DIR`，**并先把目录建好**（默认 `mkdtempSync(tmpdir()/dsh-stage-speak-asr-)`；也可用内部字段 `asrUtteranceDir` 指定）。③ 客户端新增 `.utteranceDir`；`dispose()` 清掉**自己建的**临时目录（调用方指定的目录一律不删），且该清理放在 `alive` 判断**之外**（内核崩溃时 `markDead` 早已把 `alive` 置 false，跟着早退就永远清不掉）。 |
| 2 | `lib/duplex.js`（新增） | 全双工的「识别 → 注入」半边：读 WAV → `speechToText.resolve({audio, language})` → `transcribe(spec, signal)` → `agent.steer/followup(完整 UserMessage)` → 删临时录音。含：**按句 id 去重**、目录外路径拒绝（不读也不删）、60 秒看门狗、`dispose()` 真的 `abort` 在飞识别。`handle()` **永不 reject**，只返回 `{status}` 供日志与测试。 |
| 3 | `lib/index.js` | ① `wantBargeIn` 从 `half` 扩到 `half`/`full`；② 新增 `wantDuplex`（`full` + `duplexEnabled !== false`）；③ 新增 `createDuplex` 接线：内核 `utterance-file` → `duplex.handle()`；④ 注入目标是**最近有活动的那条会话**（`duplexTargetId`，会话销毁即清空）；⑤ 三个新配置 `duplexEnabled` / `duplexLanguage` / `duplexInjectMode`；⑥ `ready` 日志加 `+asr` / `+asr-off`；⑦ 卸载时补上 `audioCore.dispose()`（此前遗漏 → 插件重载会漏下一个仍占着麦克风的内核进程）。 |
| 4 | `lib/client.js` | 「核心」组新增 3 个字段（开关 / 语言 / 注入方式）；`full` 档说明从"尚未实现，先选中不生效"改为实际行为；顺手修正 `bargeInEnabled` 的"只在半双工档起作用"（现在两档都起作用）。 |
| 5 | `test/offline.mjs` | 新增 15 条用例（8 条 `lib/duplex.js` 单测 + 1 条配置归一化 + 5 条端到端 + 1 条**防回退**）；`fakeSubprocess` 把内核的双向管道记进新增的 `kernels[]`，`fakeCtx` 支持 `agents` / `speechToText` 两个可选服务。 |
| 6 | `test/client-harness.mjs` | 面板字段数 34 → **37**（switch 11→12 / input 21→22 / select 1→2），并新增"能点到「全双工」档位"用例。 |
| 7 | 版本 | 1.7.1 → **1.8.0**（`package.json` 由 Lead 统一处理）。 |

### 根因 / 设计取舍（为什么这么做）

1. **🔴 为什么不把 `speechToText` / `agents` 写进 `export const inject`（别顺手改回去）** ——
   **因为 cordis 的 `inject` 没有 optional 语义，缺一个服务即整个插件不激活**：
   `Fiber._refresh()` 对 inject 里**每一个**名字都要求 store 里有实现，缺一个就把 epoch 置
   `INACTIVE`，而 `_setEpoch()` 只在 `epoch !== INACTIVE` 时才 `_reload()`（才执行 `apply`）。
   本机实测（把 `@deepseek-ai/cordis` 从 app.asar 解出来后跑最小复现）：

   | 场景 | 结果 |
   |:--|:--|
   | `plugin.inject = ['ghostService']`，服务缺失 | **`apply` called: false**（插件根本不激活） |
   | 同上，服务后续出现 | 此时才 `apply called: true`（在此之前**静默死**） |
   | 不 inject，`ctx.get('ghostService')` | `undefined`（安全） |
   | 不 inject，直接读 `ctx.ghostService` | 在场可读；不在场抛 `cannot get property "x" without inject` |

   所以字面写进 `inject` 的代价是：**任何没装语音 bundle 的机器上，连默认档 `off` 的播报都没了**
   —— 双工只是**可选增强**，不能拿主功能做抵押，更不能破坏本仓库「任何失败只记日志、
   绝不影响会话」的底线，以及 V1.7.0 半双工的零回归。
   落地方式：`inject` 保持 `['subprocess']`，两个可选服务一律走 `ctx.get()`（cordis 源码注释：
   *Read a service from the store without the inject requirement*）；取不到时 **warn + journal
   `duplex-unavailable`**，双工通路关闭、播报照旧。
   并加了一条**防回退断言**（`test/offline.mjs`）：`inject` 里出现 `speechToText` 或 `agents` 即测试失败。

2. **识别不放在内核里**：内核只有 MiniMax **云端** ASR 的老路径；本地 SenseVoice 由宿主提供，
   只有 Node 侧拿得到（`ctx.speechToText`）。所以内核只做"落盘 + 报路径"，不认识识别服务。
3. **必须先建录音目录**：目录不存在时内核每句都落盘失败，而事件只说 `utterance-failed`
   —— 表现为"全双工静默失效、什么错都看不到"。故 `createAudioCore` 在 spawn **之前**建目录。
4. **注入必须是完整 UserMessage**：`dsh-session` 的 `assertMessageEventShape()` 要求
   `id` 非空 string、`role === 'user'`、`source.kind` 非空 string、`content` 是数组；
   传纯字符串会在 `user/message` 事件落库时被直接拒（已逐字读过该函数）。
5. **去重按句 id**：内核重发/重放同一 `utterance-file` 时不许注入两遍；且重复事件**不删文件**
   （第一份还在读，删了会让那次识别失败）。

### 契约已核实（来自 app.asar 解出的官方源码，逐条读过，不是推测）

- `speechToText.transcribe(spec, signal)` 返回 **`{ text: string, audioSeconds: number, inferenceSeconds: number }`**
  （sensevoice provider 的 `transcriptSchema` 是 zod `.strict()`）。
- `resolve({audio, language})` 对语言有**白名单校验**，provider `info.languages = ['auto','zh','en','yue','ja','ko']`，
   名单外的值会**抛** `does not support language` → 故 `duplexLanguage` 默认 `zh`，且失败被 `duplex.js` 接住留痕。
- `transcribe` 的第二参 `signal` **必填**（官方实现第一行就是 `signal.throwIfAborted()`）。
- 内核 `wavData()` 写的是**规范 44 字节头**（RIFF / `fmt ` 16 / 1ch / 16000 / 32000 / 2 / 16 / `data`），
  与官方 `validateWave()` 的逐字段要求吻合。
- `Agent` 接口：`steer(message: UserMessage)` / `followup(message: UserMessage)`；官方 API 路径
  （`dsh-api-session-controller`）的 `prompt({ mode: 'steer' })` 用的正是
  `{ content: [{ type:'text', text }], source: { kind:'user' } }` 这条形状。

### 验证（全部本机实跑）

- `node test/offline.mjs` → **118 / 118**（基线 103 条全过 + 新增 15 条）
- `node test/client-harness.mjs` → 通过（字段 37 个：switch 12 / input 22 / select 2 / mode 1）
- `node test/smoke-audio-core.mjs` → 通过（⚠️ 需显式传一个**当前缓存里存在**的 mp3：
  脚本里写死的 `004fee86…mp3` 已被缓存清理删掉，与本版改动无关；
  `node test/smoke-audio-core.mjs ~/.cache/dsh-stage-speak/3329fb2d…mp3` → `✓ 协议冒烟测试全部通过`）
- `node --check` → `lib/*.js` / `test/*.mjs` / `scripts/*.mjs` 全 OK
- **真机内核探针（真内核 + 真外放，非替身）**：
  - `ASR_ENABLED=1 ASR_UTTERANCE_DIR=<临时目录> ./engine/audio-core` → `ready` 事件里
    **`"asrEnabled":true`**（证明环境变量名与内核读取逻辑完全对上，不只是替身测试）；
  - 内核跑起来后**外放一段已知 mp3**（同 `test/asr-e2e.mjs` 的做法），内核依次报
    `voice → silence → utterance-file`，事件字段正是 `["ev","id","path","reason","seconds"]`；
  - 落盘的 `utt-000001.wav`（142444 字节 / 4.45 秒）**通过官方 `validateWave()`**
    （从 app.asar 解出的 `@deepseek-ai/dsh-experimental-speech-to-text/wave` 原样调用）
    —— 即"内核产出的 WAV 就是识别服务接受的规范 16kHz 单声道 PCM16 WAV"这条**实测成立**，不是推断。
- ✅ **真机已验证**（2026-10-02）：`mode: 'full'` 的"真人说话 → 注入到会话"整段通过 ——
  journal 出现 `duplex-injected … steer <识别文本>`，会话里确实多出一条以用户名义的消息。
  本次覆盖到的是：内核分句落盘（真机）→ 事件契约（真机 + 替身）→ 识别调用形状（替身，按官方源码逐字对齐）
  → UserMessage 注入形状（替身，按 `assertMessageEventShape` 逐条断言）；**唯一缺口是"宿主里的
  `ctx.speechToText` 真的被调到、且 `agent.steer` 真的进了会话"**。


## V1.7.1 — 2026-10-01 · 把「原始档」独立出来（四档语义）

**来源**：用户指出 ——「应该保留一个原始档位：不加任何双工状态下，按原来那样工作也能正常运行」。

### 问题（真实的档位设计缺陷）

V1.6.0 把 `mode: 'off'` 接线成**等价于 `enabled: false`**（不注册任何监听、完全停用）。
但"**照旧念**"和"**别念了**"是两件根本不同的事，混成一个档导致：
用户想回到"没有双工"的原始行为时，只能去翻总开关 —— 而面板上明明摆着一个"关闭"档。

### 改动：四档语义各自独立

| 档位 | 含义 | 麦克风 | 内核 |
|:--|:--|:--|:--|
| **`off` 原始**（新默认） | 照旧播报，行为与 v1.5.1 完全一致 | 不启用 | 不启动 |
| `half` 半双工 | 你一开口就让路 | 启用 | 启动 |
| `full` 全双工 | 尚在规划 | — | — |
| **`mute` 静音**（新增） | 完全停用（= 原 `off` 的语义） | 不启用 | 不启动 |

- 默认值 `half` → **`off`**：不拨开关时就是原来那样（用户要的正是这个）。
- 面板第一档改名「**原始**」，并新增「静音」档；档位映射改为查表（`MODE_LABEL_KEY` / `MODE_HINT_KEY`），
  避免"新加一档忘了改渲染"这类错。

### 测试防回退（新增 2 条，共 103 条）

- `mode='off'`（原始档）**必须照旧播报**、且 `coreCalls` 为空（**不得**启动内核 / 碰麦克风）
- `mode='mute'` 才是真正停用（不注册任何监听）

### 验证

`npm test` **103 / 103**；`node test/client-harness.mjs` 通过（34 字段 / 4 档 radio）；
`node test/smoke-audio-core.mjs` 通过；`node --check` 全部文件 OK。


## V1.7.0 — 2026-10-01 · 半双工 barge-in 接线（Swift 音频内核接入）

**来源**：V1.6.0 面板上的 `half`（半双工）此前是"可选、未接线"。本次把它接到
`engine/audio-core`（Swift 常驻音频内核）：**你开口说话时，播报立刻停下让路**。
内核本身（AEC + 自适应 VAD + 播放）已在 V1.6.0 期间做好并单独验证过，本次只做**接线**，
不改 `engine/audio-core.swift` 的行为。

### 改动

| # | 文件 | 改动 |
|:--|:--|:--|
| 1 | `engine/minimax-speak.sh` | 新增 **`MMX_SYNTH_ONLY=1`：只合成不播放**。该模式不 `afplay`，把 mp3 **绝对路径**打到 stdout 一行；缓存命中同样只交路径；失败回退**不出声**，改为 stderr + 非零退出码（让 Node 侧知道"没合成出来"）。默认（不设该变量）行为逐字不变。 |
| 2 | `lib/audio-core.js`（新增） | 音频内核子进程客户端。同步工厂 `createAudioCore()`：校验内核存在 → `ctx.subprocess.spawn`（**cwd 必填**、stdin/stdout 都 `'pipe'`）→ 挂 stdout 逐行解析 JSON Lines。导出 `on(kind,fn)` / `play(path,id)` / `stop(reason)` / `dispose()` / `stats()`；`bargeInOverDb`→`VAD_OVER_DB`、`bargeInReleaseMs`→`VAD_RELEASE_FRAMES`（1024 帧 @48k ≈ 21.33ms/帧）。内核不存在 / spawn 抛错 / 没有双向管道 → **返回 null 并 warn**。 |
| 3 | `lib/engine.js` | `createSpeechEngine` 新增可选 `deps.audioCore` 与 `deps.onBargeIn`，并新增 `interrupt(reason)`。给了内核 → "wrapper 合成（synth-only）→ 内核播放"；没给 → 与 V1.5.1 **完全一致**（wrapper 自播）。内核报 `voice` → 先调 `onBargeIn(event)`，再由引擎自己 `interrupt('barge-in')`。high 优先级插队现在也会打断内核播放（`kernelPlaying`）。 |
| 4 | `lib/index.js` + `Config` | 新增 4 个字段：`audioCorePath`（默认 `./engine/audio-core`，与 `engine` 同约定，`./` 相对包根）· `bargeInEnabled`（默认 true）· `bargeInOverDb`（9）· `bargeInReleaseMs`（600）。`mode === 'half' && bargeInEnabled !== false` 时启用内核；内核不可用只 warn、退回原路径；收到 barge-in 写一条 `barge-in` journal。`ready` 日志新增 `duplex=half+kernel` 字段。 |
| 5 | `test/offline.mjs` | 假 subprocess 服务把**双向管道** spawn（音频内核）单独记进 `coreCalls`，`calls` 仍只记单向播报子进程；新增 7 条用例（见"验证"）。 |
| 6 | 版本 | 1.6.0 → **1.7.0**（`package.json` 由 Lead 统一处理）。 |

### 根因 / 设计约束（为什么这么做）

1. **播报必须交给内核播，不能继续 `afplay`**：只有内核播出来的声音才在它自己的
   AVAudioEngine 里，AEC 才拿得到回声参考；`afplay` 播的声音内核"看不见"，会被它自己的
   VAD 当成"用户在说话"→ 一播就自打断。所以 wrapper 必须增加"只合成"模式。
2. **`createAudioCore` 必须是同步工厂**：`apply()` 要同步注册事件监听，若为了等内核就绪把它
   变成 async，加载期的事件会丢。所以只做同步可判定的检查（存在性 + spawn 同步抛错），
   运行期失败（管道断开 / 内核崩溃）走 `stats().alive === false` + 事件回调降级。
3. **`SubprocessSpawnSpec.cwd` 必填**：漏了 spawn 会同步抛错且很容易被吞掉 = 完全静默失败。
   客户端里显式 `cwd` + `try/catch`，并由单测钉住。
4. **测试替身要区分两类子进程**：内核在 `apply()` 时就拉起、是常驻进程。若它混进
   `subprocess.calls`，所有"播报了几次"的断言都会被它污染（实测 27 条用例失败）。
   按"是否需要双向管道"分流后，94 条既有断言的字面与含义都**未改**。

### 验证（全部本机实测）

- `npm test` → **101 / 101 通过**（既有 94 条全绿 + 新增 7 条：①audioCore 为 null 走老路径
  ②给了 audioCore 走 synth-only + 内核播放 ③`voice` → `onBargeIn` + `interrupt`（清队列、内核收 `stop`）
  ④`interrupt` 清空队列且不抛错（有/无内核）⑤内核不存在 → null + warn ⑥JSON Lines 派发 +
  play/stop/quit 协议 + VAD 环境变量换算 ⑦barge-in 配置默认值/钳制/路径展开）。
- `node test/smoke-audio-core.mjs` → 协议冒烟全通过（ready / 完整播放 finished / 1ms 打断 / 干净退出）。
- **wrapper synth-only 离线实测**（把假 `afplay` 放 PATH 上，不发声）：
  `MMX_SYNTH_ONLY=1` 缓存命中 → stdout 打绝对路径、exit 0、**afplay 未被调用**；
  不带该变量 → stdout 为空、**afplay 被调用**（老行为不变）；
  `MMX_SYNTH_ONLY=1` 且无 Key → **exit 1、stderr 有说明、不出声**。
- **真实内核 + 新客户端联调**（一次性探针，非单测）：`ready → calibrated → started → finished`、
  `stop` 后（即便已播完）仍收到 `stopped`、`dispose` 干净退出，`stats().voices=1`。
- `node --check`：`lib/*.js`、`test/*.mjs`、`scripts/*.mjs` 全部通过。

### 遗留 / 边界

- **自打断风险（未定论，需听感验证）**：真实播放期间麦克风电平确实被抬高
  （受控实验：静默期约 -55 dBFS，播放期在 -30 ~ -43 dBFS）。受控对照里**没有**自触发 `voice`，
  但两次单发运行各出现过一次"播放期内的 `voice`"（-46.5 / -38.6）。是否稳定取决于环境噪声、
  音量与 `VAD_OVER_DB`；建议用真人开口做一次听感验证并微调阈值（属内核调参，不在本次改动范围）。
- `full`（全双工 ASR）仍未接线。
- 改 `audioCorePath` / `bargeIn*` 后需让插件重新 `apply`（配置热生效会重跑 apply）；改
  `lib/*.js` 代码则**需重启宿主**。
- 新增的 4 个字段**未加进插件页面板**（`lib/client.js` 是 V1.6.0 手写 bundle，本次刻意不动）；
  它们仍可在通用设置页改。


### 补记：Lead 复核时补的三处（同一版本内）

1. **关闭 voice processing 自带 AGC**（内核默认改）：实测它把静音期电平从 **-54 抬到 -32 dBFS（+22 dB）**，
   把"环境噪声"和"说话"一起放大，自适应门限失去意义。关掉后电平才是线性的。
2. **播放期用更严的触发门限**：新增 `bargeInOverDbPlaying`（默认 14 dB；安静期仍 9 dB），
   并在播放开始后加 **0.4s 宽限期**。依据：受控实测外放的回声抬升约 **5.5 dB**，
   而你插话时离麦克风很近、电平远高于此 —— 用更严的门限把"自己念给自己听"挡在外面。
3. **面板补齐 4 个 barge-in 参数**（`bargeInEnabled` / `bargeInOverDb` / `bargeInOverDbPlaying` /
   `bargeInReleaseMs`），让用户在自己的声学环境里按听感调参。

### 未根除的风险（必须如实记录）

**没有 ASR 的半双工档存在固有极限：仅靠电平无法区分"你在说话"与"环境噪声 / 残余回声"。**
实测环境噪声本身可达 -40 dBFS（接近说话电平），因此**自打断（误触发）无法从原理上根除**。
本版的取舍是：**误触发只导致"少念一句"，不产生任何破坏性动作**；并把调参交给用户。
若需根治，只能等全双工档接入 ASR 后用品类判定（识别出文本才算真插话）。

## V1.6.0 — 2026-10-01 · 插件页配置面板（开关 + 双工档位 + 全部 30 个可配字段）

**来源**：用户提出两件事——① "能不能给播报插件一个开关，选择打开还是关闭播报"；
② "既然在做面板，是不是应该把所有可调整项都做进去"。②的判断依据是实测：
**34 个配置字段里 30 个早就标了 `volatile()`**，即它们**一直**在设置页可改，只是挤在一张
扁平键值表里、标题是机器命名（`kickoffThrottleMs` 这种）。所以面板的价值不是"增加可配置项"，
而是**分组、中文标签、说明、当前值可见、一键恢复默认**。

### 改动

| # | 改动 |
|:--|:--|
| 1 | **新增浏览器半边** `lib/client.js`：手写 bundle（无构建步骤），在插件页注册 `plugins.bundle.config` 卡片 |
| 2 | 面板把 30 个字段分五组：**核心**（5）· **念什么**（5）· **声音与摘要**（7）· **节奏**（9）· **高级**（4） |
| 3 | **一个开关管总闸**：`enabled`；再加**三档双工开关** `mode`（关 / 半双工 / 全双工） |
| 4 | **一键恢复全部默认**：遍历 30 个字段调用 `resetField`，这是原设置页做不到的 |
| 5 | 宿主侧新增 `mode` 字段（`union(['off','half','full'])`，默认 `half`），并接入总开关判定：**`mode: 'off'` 与 `enabled: false` 等价** |
| 6 | `package.json`：`dsh.client = { platform: 'web', inject: [locale, ui-primitives, ui-plugin-manager, ui-settings] }` + `./client` 导出；版本 1.5.1 → **1.6.0** |

### 明确不做的

- **4 个技术字段不进面板**：`engine`（引擎路径）· `cwd`（子进程工作目录）——配错就彻底哑掉；
  `logFile` · `toolErrorIgnoreCodes` —— 纯排障用。它们仍在设置页可改。
- **`half` / `full` 只做"可选、不接线"**：`off` 立即生效；`half`/`full` 目前按"正常播报"处理。
  双工行为的实现见工作区 `V1.0_播报插件全双工改造技术方案.md`。

### 两条实测结论（写面板时踩到/查到的）

1. **`SwitchField` / `TextAreaField` 不是官方控件** —— 官方 `primitives` 只给 `Switch`、`Tag`
   这类原子件，字段行得插件自己拼。
2. **配置表单模型只认文本字段** —— 布尔要用 `"true"/"false"` 转义，数字/联合类型同理；
   非法值必须返回 `undefined`（= 不写入），否则脏字符串会进配置。

### 首次上线失败的三个真实根因（2026-10-01 当轮修复）

第一版面板装上去后**插件页不出现配置卡**，浏览器控制台报
`props.useStageSpeakCard is not a function` + `slot entry crashed in 'plugins.bundle.config'`。
逐条查实如下：

| # | 根因 | 证据 / 出处 | 修法 |
|:--|:--|:--|:--|
| 1 | **hook 键名多写了 `use`** | 宿主渲染器 `standardHookPropName(name)` = `` `use${name[0].toUpperCase()}${name.slice(1)}` `` —— 它**自动加前缀**。写 `useStageSpeakCard` 被翻成 `useUseStageSpeakCard`，组件拿到 undefined | 键名改为 `StageSpeakCard`（对照：`dsh-reveal-context` 用的是 `revealContextCard`） |
| 2 | **违规 `require('@deepseek-ai/dsh-client-ui-primitives')`** | 官方 App 内文档 `dsh-agent-preset/skills/cordis-plugin-development/references/practices.md` §UI 明文禁止：`dsh.client.inject` **只排序激活、不提供模块**；这些包说变就变，组件一抛错就整块空掉 | **改为原生控件**（自写 `role="switch"` 开关、`input`、`select`、三档 radio），只共享 `--dsw-alias-*` token；不再 require 任何 Harness 包 |
| 3 | 误以为 slot 注册要用 `id` | 官方模板 `templates/decoration/client.js` 用的是 `id`，但那是 **list slot**；`plugins.bundle.config` 是 **keyed slot**（`ctx.slots.register` 源码：`case "keyed": if (options.key === undefined) throw`） | 保持 `key: PLUGIN_ID`（原本就对） |

**顺带查实的两个事实**（避免以后再走弯路）：

- `ctx.configForms.get(id)` 返回的 `ConfigFormController` **自带 `getSnapshot()` 与 `subscribe()`**，
  正好满足渲染器 `bindSnapshotSelector` 要求的 `{ getSnapshot, subscribe }` 契约 ——
  所以 `hooks: { StageSpeakCard: form }` 直接成立，不需要另造 store。
- 面板不再用官方 `SettingsForm`；保存 / 放弃 / 恢复默认由面板自己调
  `form.mutate(ops, revision)`（一次提交多个字段的 `set` / `unset`）完成。

### 第四个根因：`whileServed` 门禁导致「静默不注册」（2026-10-01 二次修复）

改完前三个根因后**面板依然完全不出现，且控制台没有任何本插件的报错**。对照本机
**能正常出面板的 `dshmarket`**（用户安装后其面板立刻出现）才找到真因：

```js
// 我的写法（错）：注册被 whileServed 包住
ctx.effect(() => ctx.configForms.whileServed([PLUGIN_ID], () => ctx.slots.inject(...)))
// dshmarket 的写法（对）：无条件直接注册
ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({ name, key: PKG_NAME, locale, inject }, Card))
```

`whileServed` 的语义是「宿主设置镜像里出现该命名空间时才注册」。**条件不成立时它既不注册、
也不报错** —— 外部看到的现象就是"插件页里什么都没有 + 控制台干净"，属最难定位的一类失败。

**修法**：去掉门禁，改为无条件注册；并照 dshmarket 补上**显式自诊断**（取表单失败、
缺 `getSnapshot`、注册抛错三类都 `logger.warn` + `console.warn`，绝不静默）。

**测试防回退**：`test/client-harness.mjs` 的 `whileServed` 桩改成**一调用就抛错**，
这条断言从此钉住"不许再用门禁包住注册"。

`dshmarket` 的另外两点参考（本次未采纳，理由如下）：

- 它**直接 `require("@deepseek-ai/dsh-client-ui-primitives")` 且工作正常** —— 说明
  `practices.md` 那条禁令不是硬运行时约束。本插件仍坚持自写原生控件（依赖更少、更抗版本漂移），
  但要知道"require primitives 本身不致死"。
- 它自带 `missingPrimitives(mod)` 检查，缺控件时 `console.warn` 并**优雅停用自己**，
  而不是让组件抛错把槽位打空。这个"先检查再使用"的模式值得所有 UI 插件照抄。

### 官方文档位置（下次写 DSH 插件先去读）

App 内自带、无需联网：
`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/`
→ `dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/`
（`SKILL.md` + `references/{host-plugin,ui-plugin,practices,verification,user-actions,mcp-bundle}.md`
+ `templates/decoration/` 的最小可跑模板）。这套文档此前被忽略，是本次绕远路的主因。

### 验证

- `node --check` 通过；`npm test`（离线用例）**94 / 94 通过**，含 `mode: 'off'` 的零回归断言。
- **`test/client-harness.mjs`（新增）**：用桩件在 Node 里真实执行浏览器半边，断言
  ①只 require `react`（挡住"又去加载 Harness 包"）②slot 注册名 / key 正确
  ③hook 键名不带 `use` 且转换后存在 ④渲染出 30 个字段（switch 10 / input 18 / select 1 / mode 1）
  ⑤未改动时保存禁用、能点到第三档。**改面板先跑它，不必每次重启宿主。**
- 字典对称性自检：zh / en 各 87 键，完全对称。
- 字段覆盖自检：宿主 34 字段中，面板接入 30 个，未接入的正是上面刻意排除的 4 个。
- ⚠️ 界面渲染仍须**目视确认**（GUI 客户端模块接口需鉴权，我读不到）。

## V1.5.1 — 2026-10-01 · 规则兜底仍在断言「没有卡住」

**来源**：用户指出（承接 v1.4.2 立下的「只陈述可证实的事实」）。v1.4.0 那次只改了**模型人设**，
**规则兜底文案漏改** —— 而规则兜底恰恰是在 LLM 摘要失败时说话的那一条，实测 16 分钟内出现了 4 次：

```
还在处理中，已经走了 5 步，没有卡住。
还在处理中，已经走了 8 步，没有卡住。
```

「没有卡住」在"请求已经发出、但还没回来"时**无法证实**；它只因为有 N 步活动就顺口下了保证。

### 改动

| # | 改动 |
|:--|:--|
| 1 | 文案改为「**还在处理中，本阶段已经走了 N 步。**」/ 零步时「还在处理中。」—— 去掉断言，且把"本阶段"说准（计数是"距上次播报"的量，不是整轮） |
| 2 | 新增**系统性守卫用例**：4 种快照 × 8 类边界 × 4 个禁用词（没有卡住 / 没卡住 / 一切正常 / 快好了），任何规则兜底文案触雷即失败 |
| 3 | 测试夹具里同款措辞一并清掉（否则"没有卡住"看起来像被认可的说法） |

### 验证

- 单测 **93 → 94 全绿**（新增守卫用例 + 心跳兜底的正面断言：必须给出可核对的步数）。
- **对照实验**：回退文案 → 守卫用例 **✗ 失败**；恢复后 94/94。
- 与 v1.4.2 同源：那次改的是人设（`HEARTBEAT_PROMPT`），这次补的是规则兜底（`ruleSummary`），
  **两条路径现在都禁了同类断言**。

---

## V1.5.0 — 2026-10-01 · 多会话音色（方案 A：音色绑定会话）

**反馈**：「当我有多个会话同时进行时，因为目前语音模型用的是同一个音色，如果两边一起播报，
我就听不出来是哪个会话的内容了。」

### 机制：音色绑到"会话"这个身份上（而不是"轮次"）

| | 规则 |
|:--|:--|
| 主音色 | **第一个活跃会话**——就是现在这个，音色完全不变 |
| 备用音色 | 此后**每新开一个会话**就拿到它（用户选定：`Chinese (Mandarin)_Radio_Host` 电台男主播） |
| 归位 | 主音色会话退场后，下一个新会话重新拿回主音色 → **单会话用户永远不会听到声音漂移** |

**为什么不用"按轮次轮换"**（用户最初的字面描述）：轮次是"动作"，会话才是"身份"。
按轮次轮换会让**同一个会话的相邻两轮换声**；更关键的是，若某一边连着做几轮，
两个会话的音色就会撞在一起 —— 恰恰解决不了最初的困扰。

### 实测过的实现要点（两个坑）

1. **包内 MiniMax wrapper 忽略插件注入的 `-v`**（它取最后一个 argv 当文本），只认 `MMX_VOICE`。
   所以逐次音色必须**同时**经环境变量下发，否则"按会话换音色"根本不会生效。
2. **不能拿 `voice` 配置去下发 `MMX_VOICE`**：profile 里 `voice: 'Lilian'` 是 macOS `say` 的音色名，
   MiniMax 没有这个 voice_id，一旦下发会让云端引擎报错回退到系统 `say`。
   因此规则是：**只有拿到备用音色的会话才设置 `MMX_VOICE`**，主音色路径一个字都不改（零回归）。

### 改动

| # | 改动 | 位置 |
|:--|:--|:--|
| 1 | 新增配置 `voiceAlt`（留空 = 关闭，默认关闭） | `lib/index.js` + `cordis.patch.yml` |
| 2 | `pickSessionVoice()`：按**当前活跃会话**判据分配（非计数器），会话首次出现时定音色 | `lib/index.js` |
| 3 | `buildSpeechArgv(..., voiceOverride)`：覆盖音色进 argv，并在有覆盖时下发 `env.MMX_VOICE` | `lib/engine.js` |
| 4 | `speak(text, priority, voice)` 与队列合并逻辑一并带上音色（合并时不丢） | `lib/engine.js` |
| 5 | `createSessionState` 新增 `voiceOverride: ''` | `lib/activity.js` |

本机 profile 已写入 `voiceAlt: "Chinese (Mandarin)_Radio_Host"`（`~/.dsh/profiles/desktop/cordis.patch.yml`）。

### 验证

1. **单测**：89 → **93 全绿**（新增 4 项：不传覆盖时零回归 / 覆盖值同时进 argv 与 MMX_VOICE /
   两会话分别拿到主备音色且主音色会话退场后归位 / `voiceAlt` 留空即关闭）。
2. **对照实验**：回退"逐次音色"与"会话级分配" → **2 项 ✗ 失败**；恢复后 93/93。
3. **音色可用性**：本机实测拉取 MiniMax 系统音色清单（303 个，中文相关 42 个）并逐个生成样本，
   选定的 `Chinese (Mandarin)_Radio_Host` 与生产同链路（同名 API、`speech-2.8-turbo`、同参数）跑通；
   试听页 `V1.0_音色试听/`（8 个男声 + 当前女声对照）。缓存键含音色，两个音色不会互相污染。

---

## V1.4.2 — 2026-10-01 · 状态短语（不再念原始指令）+ 断点信号（审批 / 提问）

两条用户反馈：

> 「你相当于是直接把原始指令读了出来，中文又夹杂着，感觉很奇怪。」
> 「（审批）你会把它播成类似中间过程的感觉，我没有明确听到说这是一个需要我去审批或确认的断点。」

### 现状核实：审批播报你其实从没听到过

插件日志里 `approval` 播报 **0 条**。全部 17 次 `approval/asked` 发生在 **09-26 ~ 09-28**，
**早于插件本身**（插件 10-01 才建）；当前会话的审批提示又是关闭的。所以问题不是"体验退化"，
而是**这条路径从未被验证过**——而它一旦发生，必须是明确的断点信号。

### 改动

| # | 改动 | 位置 |
|:--|:--|:--|
| 1 | 新增 `describeTool()` 状态短语表（19 类 + 兜底）：`bash`→还在跑一条命令、`run_code`→还在跑一段脚本、`job_output`→还在等后台任务、`write/edit`→还在写/改文件、`web_search/web_fetch`→还在查资料/读网页……未收录的一律「还在跑一个操作」，**绝不回落到英文工具名**。表按**真实长调用频次**定（bash 200 · run_code 42 · ask_user_question 32 · job_output 27 · …） | `lib/activity.js` |
| 2 | `pendingWorkLine()` **不再取 `hint`**：播报里不出现任何原始参数 | `lib/activity.js` |
| 3 | 把 turn-end 的 `closer` 泛化为通用**确定性信号前缀** `signal`：收束语与断点提示共用同一机制与去重逻辑 | `lib/activity.js` + `lib/index.js` |
| 4 | **审批发起**：`signal = 「这一轮停下了，需要你审批。」` + 模型只负责说清要批什么。信号由代码写死，**模型失败也照念** | `lib/activity.js` |
| 5 | **`ask_user_question` 也当断点**：`signal = 「这一轮停下了，需要你回答一个问题。」`（实测这类等待 43 次、中位 49 秒、最长 540 秒，合计 1.2 小时，旧逻辑会把它报成"还在跑命令"） | `lib/activity.js` |
| 6 | **等用户期间抑制心跳**：`approvalPending` 或"有 `ask_user_question` 在飞"时完全不播。⚠️ 实测 **17/17** 次 `approval/asked` 都发生在有工具在飞的时候——只靠 `inFlightCalls` 判断，整段审批等待都会被报成"还在跑一条命令" | `lib/index.js` |
| 7 | 新增 `cleanApprovalReason()`：剥掉 `escalate sandbox to danger-full-access: ` 这类**纯英文机器前缀**（判据：冒号前无汉字），只留中文说明给模型，并截断到 160 字 | `lib/activity.js` |
| 8 | 审批人设补一句「不要念命令原文、路径或 JSON」；新增 `user-question` 人设与规则兜底 | `lib/summarize.js` |

### 现在的三类声音（彼此不会再混）

| 类型 | 确定性标记 |
|:--|:--|
| **收尾** | 「这一轮结束了。」/「这一轮报错中断了。」/「这一轮被中断了。」 |
| **断点** | 「这一轮停下了，需要你审批。」/「这一轮停下了，需要你回答一个问题。」 |
| **进行中** | 「还在跑一条命令，已经 1 分 2 秒。」/「还在等模型返回，已经 2 分 10 秒。」/「正在压缩上下文，已经 1 分 30 秒。」 |

### 刻意不做

**等待期不做提醒**（用户选择）：信号已在断点那一刻给过；要审批/回答你必须动手，重复播报只是打扰。

### 验证

1. **单测**：84 → **89 全绿**（新增 5 项：状态短语分类与兜底 / 原始参数反例 / 审批断点信号与等待期静默 /
   提问断点与等待期静默 / 审批文本清洗）。另按新契约**改写** 3 条旧用例（来源字段 `closer-only`→`signal-only`、
   两处"念原始命令"的断言反转为"不许念"）。
2. **对照实验**：回退状态短语、断点信号、等用户抑制三处 → 新增用例 **5 项 ✗ 失败**；恢复后 89/89。
3. **反例取自真实事故**：测试直接用用户听到的那条
   `BEFORE=$(wc -l < ~/.dsh/dsh-stage-speak.log); echo "开始 UTC $(date -u +%H:%M:%S)"` 当输入，
   断言播报里不含 `wc -l` / `BEFORE` / `$(` / `~/.dsh` / `bash` / `echo` 任何一项。

---

## V1.4.1 — 2026-10-01 · 线上验证抓到的「还在等模型返回，已经 4 秒」

**来源**：v1.4.0 重启后的首次线上验证（不是回放、不是单测，是真跑）。

### 现象

```
07:14:31  announce  progress-heartbeat  仍在执行 bash（…），已等待 54 秒        fact   ← 正确
07:15:16  announce  progress-heartbeat  还在等模型返回，已经 4 秒。            fact   ← 问题
```

### 根因：触发看"静默多久"，内容讲"这次等了多久"，两者不是同一件事

心跳的触发条件是**距上次播报超过 `silenceHeartbeatMs`**（30 秒）。但事实型话术念的是
**当前这条事实自己的时长**。于是：一次久静默之后紧接着开一次**新的**模型调用，
触发条件立刻满足，话术却只能念出「已经 4 秒」——**是真话，但没有信息量**。

### 修复

**要求事实本身也够"有料"才开口**：`factAge`（在飞调用的已跑时长 / 等待态的已等时长）
必须同样达到 `silenceHeartbeatMs`，否则本 tick 跳过。让**消息内容决定触发**，而不是只看静默时长。

修复后同一场景：那次新开的模型调用不会被念；等它自己长到 30 秒以上才会说
「还在等模型返回，已经 30 秒。」——那才是有信息量的一句。

### 验证

- 单测 83 → **84 全绿**（新增 1 项，按真实时序驱动：久静默 → 新开模型调用 → 必须先沉默 →
  事实够久后恰好出声一次）。
- **对照实验**：回退 `factAge` 守卫 → 该用例 **✗ 失败**；恢复后 84/84。
- 线上复验：需**再次重启**后才生效（本条修复晚于本次重启），下次重启后按同一手法再看日志。

> 教训（已写进开发事实）：**单测与回放都过了，不代表上线就对了。**
> 本条只有把插件真正跑起来、让人耳/日志观察一段时间才会暴露 —— 触发条件与话术内容
> 是两个独立变量，任何"用 A 判断该不该说 B"的地方都要单独核一遍。

---

## V1.4.0 — 2026-10-01 · 长生成期间的播报（并纠正上一轮的一个结论）

**目标**：补齐"模型单次长生成"期间听不到任何动静的空白。

### 先纠正我自己：时间兜底式的"报平安"不做

上一轮我提出过按时间兜底报"没卡住"（B 方案）。按**插件实际能知道的状态**重放 33 个真实会话 /
393 段 >60 秒静默后，这个方案被证伪：

| 静默开始时的状态 | 段数 | 总时长 | 处置 |
|:--|--:|--:|:--|
| 轮次已结束（用户在做别的） | 146 | 677,971s | 不该播 |
| 等用户批准（球在用户手上） | 6 | 149,702s | 不该播 |
| A 工具在飞 | 197 | 35,418s | v1.2.1 已覆盖 |
| **B 等模型返回** | **44** | **5,258s** | **本版补上** |
| C 完全无信号（真空） | **0** | **0s** | **不实现** |

**C 是 0 段 0 秒** —— 给它加兜底播报等于零收益 + 编造风险。同批证伪的还有第二个猜测：
`tool/ptc-dispatch-start` 是嵌套在父 `tool/call` 里的并行调用，计不计入**差 0 秒**，v1.2.1 在这里没有洞。

### 依据：官方事件定义，不是推测

`@deepseek-ai/dsh-session` 的 `types.d.ts` 明写：

> `step/start` — Opens step `step` of turn `turn` — **one model call plus the tool executions it requested.**

即：**`step/start` 之后、`assistant/message` 之前，主机确定处在一次模型调用之中**，而这整段零会话事件。
B 段真实规模：中位 **92 秒**、最长 **323 秒**（>120s 的 16 段、>180s 的 6 段）。

### 改动

| # | 改动 | 位置 |
|:--|:--|:--|
| 1 | 新增一等状态 `waitingKind`/`waitingSince`：`step/start`、`llm/retry-started` 置为 `model`，`compaction/start` 置为 `compaction`；`assistant/message`/`assistant/attempt`/`tool/call`/`step/end`/`compaction/end`/`turn/start`/`turn/end` 清位。**不随 `drain()` 清零**（同 `inFlightCalls` 的道理） | `lib/activity.js` |
| 2 | 心跳守卫放开第三格：`有新事件 \|\| 有工具在飞 \|\| 正在等模型` 三者有一即可播 | `lib/index.js` |
| 3 | 话术**确定性模板、不过模型**：「还在等模型返回，已经 2 分 10 秒。」/「正在压缩上下文，已经 1 分 30 秒。」与工具在飞的「仍在执行 bash（sleep 180…），已等待 2 分 58 秒」形成稳定区分 | `lib/activity.js` |
| 4 | 事实型播报（在飞 / 等模型）**不调摘要模型**：零编造风险，也省一次往返。守卫：只有当快照里确实只有这条事实时才采用，期间若来了新事件就照旧走摘要（免得念出已经过时的话） | `lib/index.js` |
| 5 | 新增 `formatDuration()`：时长念成「2 分 10 秒」而不是「130 秒」——这类播报的全部价值就是让人不用费脑子换算 | `lib/activity.js` |
| 6 | **节奏方案「丁」**：等模型类续报有 60 秒下限（`modelWaitMinGapMs`），**不新增用户可见旋钮**（该项刻意不加 `volatile()`，不出现在设置页）；工具在飞、或有真实缓冲内容时不受此限 | `lib/index.js` |
| 7 | 修掉一个静默的编造源：心跳人设原文写着"让他安心知道**工作没卡住**"，而这在"请求已发出、还没回来"时无法证实 → 改为明确禁止断言"没卡住/一切正常/快好了" | `lib/summarize.js` |
| 8 | `announce` 行来源字段新增 `fact` 取值 | `lib/index.js` |

### 刻意不做

- ❌ **不做 C 真空兜底**（实测 0 段）
- ❌ **不做 PTC 单独计数**（实测差 0 秒）
- ❌ **不放松"真卡住不报"**：报的是"正在等模型返回"这一**事实**，不是"进展顺利"
- ❌ **不加提示音、不换音色**（听觉标记方案仍未采用）

### 验证（四重）

1. **单测**：76 → **83 全绿**（新增 7 项：时长口语化 / 进入等待态 / 五类结束事件清位 / 重试与压缩 /
   端到端长生成必须出声且不调模型 / 续报下限内不重复且越限续报 / 事实型守卫。另按新契约**改写**了
   2 条旧用例：事实型心跳不再走摘要、时长断言由 `178 秒` 改为 `2 分 58 秒`）。
2. **对照实验**：把"等待态置位"临时改成空实现 → 新增用例 **7 项 ✗ 失败**；恢复后 83/83 全绿。
3. **真实数据回放**：33 个会话里 44 段等模型静默**全部被覆盖**，这些时段新增播报 **83 次**，
   段内最长静默 **323 秒 → 60 秒**。
4. **时序依据**：`compaction` 清位是否安全，由真实时序 `compaction/start → summary → end → step/start`
   确认（end 之后紧跟的 step/start 会重新进入等待态，不留空白）。

---

## V1.3.1 — 2026-10-01 · 收束语被连说两遍（v1.3.0 引入的回归）

**现象**（用户实听，06:53）：一轮结束的播报是 **「这一轮结束了。这一轮结束了。」** —— 同一句话连听两遍。

### 定性：不是播了两条，是**一条文本里出现了两遍**

| 证据 | 内容 |
|:--|:--|
| 插件审计日志 | 只有 **一条** `boundary turn-end`（06:53:06.980）与 **一条** `announce turn-end 这一轮结束了。这一轮结束了。`（06:53:12.239） |
| 引擎侧日志 | 只有 **一次** 调用；MiniMax 计费的 `usage_characters` 为 26，而 06:44 那条单句（7 字）是 13 —— **正好 2 倍**，反证引擎只收到一条、只念一遍 |

### 根因：两个缺陷叠加，且都是 v1.3.0 引入的

| # | 缺陷 | 说明 |
|:--|:--|:--|
| 1 | `drain()` 只暴露 **"距上次播报"** 的计数，而它**每次心跳都被清零** | 现场时序：06:52:47 最后一次 `tool/call` → **06:52:49 心跳播报 drain() 清零** → 06:53:06 `turn/end` 时快照里 `toolCalls = 0`（而这一轮实际干了 30 步）。**与 V1.1.4 修过的是同一类错误，只是漏在规则摘要这一层** |
| 2 | 规则兜底在 `toolCalls === 0` 时吐出的**恰好就是收束语本身**：「这一轮结束了。」 | 与 v1.3.0 的确定性收束语拼成重复两遍。`composeAnnouncement` 当时不做去重，把重复原样送进了引擎 |

离线复现（把两处修复回退后跑）：输出 **`这一轮结束了。这一轮结束了。`** —— 与用户听到的完全一致。

### 修复

| # | 改动 | 位置 |
|:--|:--|:--|
| 1 | `drain()` 快照新增 `turnToolCalls`（轮次级累计，**播报不清零**） | `lib/activity.js` |
| 2 | `ruleSummary` 的 turn-end 分支改用 `turnToolCalls`；**零步文案不再等于收束语**（改为「这一轮没有具体操作。」） | `lib/summarize.js` |
| 3 | `composeAnnouncement` **去重**：摘要已以收束语开头时不再前置拼接（模型自行写出该句时同理） | `lib/index.js` |
| 4 | **可观测性**：新增 `summarizeDetailed()`，`announce` 行增加第 4 字段标注来源 `llm` / `rule` / `closer-only` | `lib/summarize.js` + `lib/index.js` |

第 4 条是本次排查的直接教训：日志里只有最终文本，**无法判断走的是 LLM 还是规则兜底**，只能靠推理猜，白花一轮。
现在 `grep announce` 一眼可辨。日志格式向后兼容（前 3 段不变，第 4 段新增）。

修复后的同一时序输出：**「这一轮结束了。这一轮做完了，一共 30 步操作。」** —— 不重复，且步数是整轮真实步数。

### 验证（三重）

1. **单测**：72 → **76 全绿**（新增 4 项：去重 / 轮次级计数与零步文案 / 端到端"收束语只许出现一次" / 来源字段三态）。
2. **对照实验**：把第 1、3 条修复临时回退 → 新增用例 **3 项 ✗ 失败**，其中端到端那条打印出的正是 **`这一轮结束了。这一轮结束了。`**；恢复后 76/76 全绿。
3. **真实时序复刻**：用例按现场顺序驱动（`tool/call` → 心跳 drain → `turn/end`），不是构造的理想路径。

---

## V1.3.0 — 2026-10-01 · turn-end 确定性收束语（"听不出来这一轮结束了"）

**现象**（用户反馈）：一轮任务全部做完之后，**听不出来这是一个明确的会话结束信号** ——
分不清刚才是"这一轮收尾了"还是"中途又报了一次进展"。

### 根因：结束信号被交给了模型，于是它成了一个随机事件

审计 `~/.dsh/dsh-stage-speak.log` 里全部 213 条播报：

| 事实 | 数据 |
|:--|:--|
| turn-end 播报 | 30 条（14%） |
| 其中带任何收尾措辞的 | **仅 4 条**，且措辞各不相同："这轮任务完成" / "这轮结束了" / "这轮把…" / "这一轮做完了" |
| 同期**中途**进展播报中，也含同类词汇的 | **10 条**（共 156 条） |

两边词汇重叠 → 耳朵没有**任何**可依赖的判别特征。三处代码成因：

| # | 问题 | 位置 |
|:--|:--|:--|
| 1 | turn-end **没有专用人设**（kickoff、progress-heartbeat 都有），落到通用阶段人设上 | `summarize.js` |
| 2 | turn-end 的补充要求只写"总结做成了什么 + 转达待决事项"，**没有"必须报出结束"** | `summarize.js` |
| 3 | `reason.kind`（实测 completed 224 / error 15 / aborted 2）进了缓冲却**从不进入摘要** → "报错退出"和"正常完成"听感一样 | `activity.js` |

唯一确定性的结束语是规则兜底那句「这一轮做完了，一共 N 步操作。」——只在模型失败时出现，且措辞机械。

### 修复（A 方案：收束语由代码写死，不经过模型）

| # | 改动 | 位置 |
|:--|:--|:--|
| 1 | 新增 `TURN_END_CLOSER` + `closerFor(kind)`：完成→「这一轮结束了。」报错→「这一轮报错中断了。」中断→「这一轮被中断了。」未知 kind 回退到正常结束 | `lib/activity.js` |
| 2 | turn-end 边界带上 `closer` 字段（顺带修好成因 3：报错/中断终于听得出来） | `lib/activity.js` |
| 3 | 新增纯导出 `composeAnnouncement(closer, text)`：收束语拼在**摘要之前**；摘要为空时收束语仍出声 | `lib/index.js` |
| 4 | 摘要为空且有收束语 → 照播收束语（旧行为是 `dropped` 静默，**恰恰在结束信号上最不能沉默**）。通道契约不变：每个边界仍只留一条结局 | `lib/index.js` |
| 5 | 新增 `announceTurnEndOnChat`（默认 `true`）：零工具调用的**纯聊天轮次**不念摘要，但**照播收束语** —— 旧行为是整轮静默，那些轮次用户永远等不到结束信号 | `lib/activity.js` + `lib/index.js` |

### 为什么收束语必须放句首（结构性理由）

`truncateForSpeech`（`clean.js`）只保留**前缀窗口**：`text.slice(0, maxChars)` 再回退到最后一个句末。
**句尾内容在摘要超长时会被整段截掉** —— 收束语放句尾，会在摘要最长的时候恰好消失。
放句首则永远安全（有专门测试：`maxChars: 12` 下收束语依旧完整）。

### 刻意没做的事

- **不加提示音、不换音色**（C 方案）：先把确定性收束语跑起来，听几天再决定是否需要听觉标记。
- **不用"专用人设 + 要求模型说结束语"**（B 方案）：模型不保证遵守，偶发丢失就无法作为可靠信号，
  这正是本版要根除的问题。A 与 B 的区别就是"100%"与"大概率"。

### 验证（三重）

1. **单测**：66 → **72 全绿**（新增 6 项：三种 kind 文案 / 区分完成·报错·中断 / 中途播报不许带收束语 /
   `maxChars` 截断后收束语仍完整 / `composeAnnouncement` 空值四态 / 聊天轮次只播收束语且不调模型；
   并**改写**了旧用例「纯聊天轮次仍然不播 turn-end」——它编码的正是本次要改掉的行为）。
2. **对照实验**：把 turn-end 临时回退为 v1.2.1 行为后重跑 → 新增用例 **3 项 ✗ 失败**（聊天轮次静默、
   收束语缺失、截断用例），恢复后 **72/72 全绿**。证明测试真能抓住该缺陷。
3. **文案来源**：三种 kind 的取值与占比（completed 224 / error 15 / aborted 2）来自 40 个真实会话
   `turn/end` 事件统计，不是拍脑袋设定。

---

## V1.2.1 — 2026-10-01 · 长工具调用期间的整段静默（用户实测 187 秒无声）

**现象**：用户跑便携投影仪选型任务时，中间有 **187.2 秒（14:28:25→14:31:33）完全没有任何播报**。
不看屏幕就无法判断"是不是卡住了、是不是报错退出了"。

### 根因：在飞的工具调用不算"活动"，还被上一次播报的 drain() 抹掉了痕迹

时间线（全部来自 `~/.dsh/dsh-stage-speak.log` 与 `session-bf5919b7` 原始事件，非推测）：

| 时刻 | 事件 | 对判定的影响 |
|:--|:--|:--|
| 14:28:18.590 | 工具调用 `bash {"command":"sleep 180; echo waited"}` | 缓冲里写入唯一一条活动证据，`toolCallsSinceAnnounce`=1 |
| 14:28:22.606 → 14:28:25.892 | 心跳 tick 判定 → 播报完成 | `drain()`（index.js:282）**把缓冲与计数一起清零** → 在飞调用的痕迹被消费 |
| 14:28:25.892 → 14:31:18 | 阻塞等待的 178 秒 | **零会话事件**：调用没返回（无 `tool/result`）、模型没生成（无 `assistant/message`）；期间 `agent/inbox/spliced`（子代理回信）不是 `noteEvent` 认的类型；**成功的 `tool/result` 也不计活动**（activity.js 非错误即 return） |
| 每个 tick | 守卫第③条 `index.js:406` | `entries.length===0 && toolCallsSinceAnnounce===0` → `continue`，连续 **10 个 tick** 全部倒在同一条 |

讽刺的是这 187 秒**任务一直在推进**：14:30:06 / 14:30:12 后台调研子代理两次把结果送回会话，
插件既看不见、也不会念。

**这不是偶发**：全日志 16 段 >120s 空档里 **14 段**是同一签名（空档内没有任何 `boundary` 行）。

### 修复

| # | 改动 | 位置 |
|:--|:--|:--|
| 1 | 新增 `state.inFlightCalls`：`tool/call` 记入、`tool/result` 销账（按 `toolCallId` **精确配对**，拿不到时 FIFO 兜底；成功与失败都要销） | `lib/activity.js` |
| 2 | **不随 `drain()` 清零** —— 在飞调用是最确定的活动，必须与活动缓冲解耦 | `lib/activity.js` |
| 3 | 心跳守卫改为「缓冲有活动 **或** 有调用在飞」才允许播报 | `lib/index.js` |
| 4 | 缓冲已被抽干时，用 `pendingWorkLine()` 补一条**如实描述**（在跑什么 + 等了多久 + 并发几个），避免摘要对着空快照说废话 | `lib/activity.js` + `lib/index.js` |
| 5 | `turn/start` 与 `turn/end` 都清空在飞记录，防止中断留下的幽灵永远点亮心跳 | `lib/activity.js` |

### 刻意没有放松的底线

**真卡住时依旧沉默**：在飞计数归零且无新事件时，守卫照旧不报 ——
不为填静默而编造"正在努力工作"。这是 V1.1.4 定下的原则，本版只修"把活动误判成没活动"，不改它。

### 验证（三重）

1. **单测**：新增 5 项（`回归 187s 静默：长工具调用飞行期内…必须报` / 调用结束后必须恢复沉默 /
   callId 乱序配对 / turn 边界清空 / 描述文案），**61 → 66 全绿**。
2. **对照实验**：把 `lib/index.js` 临时还原为 HEAD（旧守卫）后重跑 → 新增那条回归测试 **✗ 失败**，
   还原修复版 → ✓ 通过。证明测试真能抓住该缺陷，不是假绿。
3. **真实事件流回放**：拿 `session-bf5919b7` 的原始事件按真实时间交织重跑 → 同一段 187.2 秒由
   **0 次播报变为 3 次**（等待 49s / 94s / 139s 各报一次，最长静默 45s = 设计上限）；
   06:31:18 调用返回后在飞归零 → 06:31:22 的 tick 正确保持沉默。

### 仍存在的已知边界（未修）

**模型单次长生成期间的零事件窗口**：若模型连续几分钟只生成、不调工具，同样没有任何会话事件，
心跳仍会沉默。要覆盖它只能引入"无活动也按时间兜底播报"（V1.2.0 讨论中的 B 方案），
本轮**经用户确认不采用** —— 那会牺牲"真卡住不编造"的底线。

---

## V1.2.0 — 2026-10-01 · 按官方规范重写为可开源、自包含的插件

这一版不改播报行为，改的是**包的形态**：让它符合 DSH 官方插件规范、可以干净地开源到 GitHub，
并且不再依赖包外的任何文件。

### 依据

- 官方《打包与安装插件》：<https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish.md>
- 官方《插件与生命周期》：<https://deepseek-harness.github.io/deepseek-harness/develop/framework/index.md>
- 官方《插件生态倡议书》三条原则：组合优先 / 声明清晰 / 兼容优先

### 引擎自包含（本版最大改动）

**问题**：引擎脚本与配置文件原本散落在 `~/.dsh/tools/`，profile 里靠**绝对路径**引用。
别人 `dsh plugin add` 之后拿到的是一个没有引擎的骨架 —— 这同时违反"组合优先"与"声明清晰"。

| 项 | 之前 | 现在 |
|:--|:--|:--|
| 引擎位置 | `~/.dsh/tools/minimax-speak.sh`（包外） | **`engine/minimax-speak.sh`（包内，随包分发）** |
| 引用方式 | profile 里的绝对路径 | `engine: ./engine/minimax-speak.sh` —— `./` 相对**包根**解析 |
| 默认模型/音色 | 只能放包外的用户目录 | **包内 `engine/minimax-{model,voice}.txt` 作为默认**，用户文件仍可覆盖 |
| 路径字段 | 必须写绝对路径 | `logFile` / `engine` / `cwd` 支持 `~/`（插件展开） |

配置优先级（高 → 低）：**环境变量 → `~/.dsh/tools/minimax-{model,voice}.txt` → 包内默认 → 内置默认**。
用户覆盖优先于包内默认是刻意的：包目录会被 `git pull`/重装覆盖。

### 按官方要求声明 peerDependencies + devDependencies

官方明文：「需要与宿主共享实例的 dsh 包要**同时**声明在 `peerDependencies` 与 `devDependencies`」。
本包此前两样都没有，还写了条注释说"刻意不声明"—— **该结论已被实验证伪**：

| 实验 | 结果 |
|:--|:--|
| 复刻 profile 的 pnpm 设置（`nodeLinker: hoisted` + `autoInstallPeers: false`）后安装一个声明了 peer 的包 | **exit=0**。pnpm 只输出一条 `WARN Issues with peer dependencies found` 列出期望的宿主包，**不联网拉取、不失败** |
| 官方 CLI 重装本包（已含新 peer 声明） | **exit=0**，且**未被兼容性闸门判定为 incompatible** |

⚠️ **范围写法有个 semver 陷阱**（实测）：`>=0.1.7-rc.1 <2`、`^0.1.0-rc.6`、`>=0.1.5-rc.2 <2`
**都不匹配 `0.2.0-rc.2`** —— 预发布版本只能被"元组相同的 comparator"覆盖。正确写法是同 minor 分段：

```
>=0.1.7-rc.1 <0.2.0 || >=0.2.0-rc.1 <0.3.0
```

`dsh.engines.dsh` 与三个 dsh 服务包的 peer 都改用这个范围。**本包原来的 `>=0.1.7-rc.1` 对运行中的
DSH 0.2.0-rc.2 其实不满足**，属于潜在缺陷，本版一并修掉。

### 删除测试替身，测试改为标准跑法

`devDependencies` 现在装的是**真实的 `@deepseek-ai/*` 包**（schemastery 3.18.4 等），
因此 `test/schemastery-stub.mjs` 与 `test/stub-loader.mjs` **已删除**：

| | 之前 | 现在 |
|:--|:--|:--|
| 跑法 | `node --import ./test/stub-loader.mjs test/offline.mjs` | `npm test`（标准） |
| 本地依赖 | 靠 resolve hook 造假替身 | 真实的 devDependencies |
| 风险 | 替身漏进 `node_modules/` 会顶掉宿主真库 | 该风险消失 |

`//no-local-node_modules` 备忘保留，但说明已改写为历史事故记录。

### 开源前安全检查

- **仓库内不含任何密钥**：扫描确认；唯一命中是测试里 `const secret = 42` 的代码块样例
- 新增 `scripts/check-secrets.mjs` + `npm run check-secrets`：特征扫描（`sk-`/`gho_`/`AKIA`/JWT/裸 `Bearer`/绝对家目录路径）
  **加上真值比对** —— 把本机真实密钥（`MINIMAX_API_KEY` 或 `~/.mmx/config.json`）与真实用户名读入内存逐字比对；
  密钥与用户名只存在于运行时内存，脚本内不硬编码任何私人字符串
- 引擎密钥来源改为 `MINIMAX_API_KEY` 环境变量（优先）或 `~/.mmx/config.json`，**两者都在仓库之外**；
  新增 `engine/minimax-redact.txt.example`（示例，不含真实词表）
- 新增 `SECURITY.md`：硬约束、密钥存放位置、已泄漏时的处置、以及"播报文本会离开本机"的边界

### 包形态合规

| 文件 | 状态 |
|:--|:--|
| `LICENSE` | ✅ 新增（此前只在 package.json 写 MIT，仓库里没有文件） |
| `SECURITY.md` | ✅ 新增 |
| `.gitignore` | ✅ 新增（含 `.env` / `*.pem` / `.mmx/` / `minimax-redact.txt` 等密钥类） |
| `README.md` | ✅ 改为英文（GitHub 默认视图），并修掉原文 3 处泄漏本机用户名的绝对路径 |
| `README.zh-CN.md` | ✅ 中文版改为独立文件 |
| `files` 白名单 | ✅ 补 `engine` / `scripts` / `SECURITY.md` / `LICENSE` / 两个 README |

### 测试

**59 → 61 全绿**。新增 2 项：路径字段 `~/` 展开；`engine` 的 `./` 包根相对解析（含 `../`、绝对路径、裸命令名、空值）。

### 部署与验证

| 项 | 结果 |
|:--|:--|
| 全新安装路径（`dsh plugin remove` + `add`） | ✅ 1.2.0 到位，`engine/` 随包落地，**可执行位保留**，bundle 自动重挂 |
| 官方兼容性闸门 | ✅ 本包未被判 incompatible（只有 `dsh-config-manager@0.1.64` 被拦） |
| 端到端出声 | ✅ 插件 → 兼容 shim → 包内引擎 → 实际听到播报 |

### 一个实测事实：**直接改 profile patch 文件不会触发热重载**

受控实验：把旧引擎临时移开，插件立刻报
`speak-error  spawn /Users/<user>/.dsh/tools/minimax-speak.sh ENOENT`
—— 证明运行中的实例仍在用**旧配置值**。"配置改动热生效"这条对**直接编辑文件**并不成立（至少本次如此）。

**处置**：`~/.dsh/tools/minimax-speak.sh` 改为一个 **兼容 shim**，只把调用转交给包内引擎，
保证**只有一个真源**。重启后配置指向包内引擎，该 shim 即可删除。

> 教训：又一条"拿间接结论当事实"。以后验证"配置是否生效"用**受控对照**（移开旧路径看是否报错），
> 不要靠"文档说会热重载"。

### 部署

改的是代码 → **需重启 DSH**。重启后：新代码生效（`./` 包根相对解析、`~/` 展开）；
profile 的 `engine` 指向包内引擎；`~/.dsh/tools/minimax-speak.sh` 这个 shim 可删。

## V1.1.5 — 2026-10-01 · 消除观测死角：判定了就必须留下留痕

全面回归时发现：审计日志里 **66 条边界判定只有 60 条播报**，剩下 6 条**查不到任何原因**。
逐条归因后确认是两类，而它们**都不写日志**：

| 类别 | 条数 | 原状 |
|:--|--:|:--|
| 同优先级窗口内被合并 | 2 | `schedule()` 直接丢弃，无留痕 |
| 插件重载掐掉在途播报 | 2 | `flush()` 里 `if (disposed) return`，无留痕 |
| 子代理会话（`includeSubagents:false`） | 1 | 设计不播，也无留痕 |
| 仍在播报中 | 1 | 时序问题，非缺陷 |

**根因**：`flush()` 的失败分支只调 `warn()`（写宿主 logger），**不写审计日志**；
静默 `return` 同样不留痕。于是「判定了却没播」在日志里**无法归因** ——
这正是反复出现"这里修完那里又出问题"却查不动的原因。

### 修法：确立通道契约

**每个判定过的 `boundary`，最终必定留下四种留痕之一：**

| 留痕 | 含义 |
|:--|:--|
| `announce` | 正常播报 |
| `coalesced` | 被已挂起的边界合并（新增） |
| `dropped` | 摘要为空 / 插件已卸载重载（新增） |
| `pipeline-error` | 流水线抛错，含错误信息（新增） |

### 测试

59 项全绿。新增「通道契约」测试：用临时 `logFile` 观测真实留痕，
断言 `boundary 数 == announce + dropped + coalesced + pipeline-error`。

### 部署

改的是代码 → **需重启**。

## V1.1.4 — 2026-10-01

## V1.1.4 — 2026-10-01 · turn-end 播报被中途的心跳吃掉（用户「没明显感知」的真因）

用户反馈 V1.1.3 修完「没明显感知」。查真实事件流，发现**收尾播报根本没被创建**。

### 实测时序（2026-10-01 04:45–04:48，真实会话）

```
04:45:31  ▶ turn/start #1
04:48:24      announce progress-heartbeat   ← 心跳播报，drain() 把 toolCallsSinceAnnounce 清零
04:48:27  ■ turn/end   本轮工具调用 = 21    ← 仅 3 秒后
```

该轮干了 **21 步**，却因为心跳早 3 秒而被判定「没干活」→ **整轮收尾播报静默丢弃**。
而收尾播报正是承载「要不要我做 X」这类待决事项的那一条 —— 所以 V1.1.3 的内容修复无从体现。

### 根因：把「距上次播报的活动量」当成了「这一轮有没有干活」

```js
drain() { state.toolCallsSinceAnnounce = 0 }              // 每次播报（含心跳）都清零
turn/end 判定: if (toolCallsSinceAnnounce < 1) return null // 于是返回 null
```

两者不是一回事。播报会清零前者，轮次结束不会。

### 修法

新增 `turnToolCalls`（**只在 `turn/start` 清零**，播报不清零），`turn/end` 改用它判定。

### 测试

58 项全绿。新增 2 项：
- 「中途播报清零计数后，turn-end 仍必须播」—— 精确复现上述时序
- 「纯聊天的一轮（零工具调用）仍然不播 turn-end」—— 守住原来的意图

### 部署

改的是代码 → **需重启**。

## V1.1.3 — 2026-10-01

## V1.1.3 — 2026-10-01 · 收尾提问被截断吃掉（用户发现的）

用户指出：那一轮我明明在结尾问了「要不要顺手做个余额预警」，播报却说「不需要你决定什么」。

### 根因（实测 243 个有收尾消息的轮次）

| 指标 | 值 |
|:--|--:|
| 助手收尾消息长度**中位数** | **1615 字** |
| 超过 160 字的轮次 | 226（93%） |
| 末尾 200 字内含「需要你决定」信号 | 79（33%） |
| 其中信号**落在前 160 字内**的 | **7** |
| **→ 被截断吃掉的** | **72（91%）** |

记录活动时把助手消息截成**前 160 字**。而写作者的习惯是**结论在前、提问在后** ——
提问几乎必然落在被切掉的部分。摘要模型看不到问题，就只能说「不需要你决定什么」。

### 修法

1. **头尾都留**：`ASSISTANT_HEAD = 100` + `ASSISTANT_TAIL = 200`，中段用「……（中略）……」占位。
   开头保住结论，末尾保住待决事项。
2. **`turn-end` 的提示词明说**：如果收尾消息里提了问题、给了选项，**必须转达**；
   只有确实无待定事项时才说「不需要你决定什么」。

### 测试

56 项全绿（新增：900 字的收尾消息 + 末尾提问 → 提问必须出现在 prompt 里）。

## V1.1.2 — 2026-10-01

## V1.1.2 — 2026-10-01 · 两个真 bug（开工反馈在真实环境里从未触发过）

用户问「是不是每一个轮次都能有这种反馈触发？」→ 去翻真实会话日志回测，
发现 **248 个 turn/start 里 0 个能触发**。查出两个 bug。

### Bug A（致命）：事件顺序与假设相反

真实 seq 顺序是 **`turn/start`(seq 5) 先于 `user/message`(seq 9)**。
而 `turn/start` 分支里检查 `pendingUserTask` —— 那时用户消息**还没到**，必然是空的。
→ **开工反馈在真实环境里 100% 不触发。**

**修法**：开工反馈改由 **`user/message` 分支触发**（拿到真消息时）。
`turn/start` 分支保留为兜底（万一某宿主顺序相反），两者共用 `kickoffDoneThisTurn` 保证一轮只播一次。

### Bug B（一直在悄悄影响摘要）：没过滤系统注入

实测 58 个会话 / 303 条 `user/message`，**真用户输入只占约一半**：

| source.kind | 条数 | |
|:--|--:|:--|
| **user** | **156** | ← 真用户输入 |
| agent-instructions | 44 | **31KB 的 AGENTS.md 注入** |
| runtime-context | 32 | |
| skill-catalog | 22 | **29KB 技能目录** |
| tool-jobs / agent-message / subagent-settled / compact-checkpoint / goal / user-approval / tool-goal | 45 | |

`textOfMessage` 不筛 kind → `lastUserTask` 被 30KB 注入覆盖 →
摘要 prompt 里的「用户交代的任务」实际是 `<system-reminder>A skill is…`（截断 300 字）。

**修法**：新增 `isRealUserMessage()`，只认 `source.kind === 'user'`（`source` 缺失时放行以兼容旧日志）。

### 回测（修复后，248 个真实轮次）

| | 轮次 | 占比 |
|:--|--:|--:|
| ✅ 触发开工反馈 | **200** | **80.6%** |
| ⬜ 有真消息但短于 4 字（"继续"） | 32 | 12.9% |
| ⬜ 整轮无真用户消息（自动续跑/goal/恢复） | 16 | 6.5% |
| 🚫 正确过滤掉的系统注入 | 405 | — |

### 🩸 最该记住的教训

**第一版测试把事件顺序写反了**（`user/message` → `turn/start`），
于是测试全绿、生产 0 命中 —— **测试固化的是我的假设，不是现实**。
新测试一律照抄真实 seq 顺序，并显式标注来源。

### 测试

55 项全绿（新增：真实顺序触发、系统注入不触发且不污染任务、同轮插话不重复播）。

## V1.1.1 — 2026-10-01

## V1.1.1 — 2026-10-01

### 修复：插件在某轮中途挂载时，当轮永远不触发心跳

**现象**（重启后实测）：重启后插件于 04:29:13 挂载，但用户紧接着那条消息的
`turn/start` 发生在挂载**之前** → 插件从未见到该轮的 `turn/start` →
`state.turnActive` 恒为 `false` → **当轮静默心跳永不触发**。

**根因**：`turnActive` 只在 `turn/start` 分支里置位。插件错过的任何一轮
（重启、热重载、"已存在的会话收不到新挂载"）都会掉进这个洞。

**修法**：`tool/call` 分支兜底 —— 只要还有工具调用在流，就说明这一轮确实在进行，
置 `turnActive = true`（`turnStartedAt` 为空时一并补上）。`turn/end` 仍负责关闭。

**测试**：新增 1 项「中途挂载也能心跳」，**53 → 54 全绿**。

### 部署说明

本版仍是**改代码 → 需重启**。但**不急着为它单独重启**：
重启后第一轮的心跳缺失只影响那一轮，**从第二轮起一切正常**。下次自然重启时该修复即生效。

## V1.1.0 — 2026-10-01

## V1.1.0 — 2026-10-01

### 新增：拟人化播报（开工反馈 + 静默心跳）

用户反馈两点：**① 交代任务后没有"第一时间"的回应；② 工具调用期间长时间静默，不看屏幕就不知道有没有在干活。**

原设计是纯事件驱动（最短的反馈也要等 8–12 次工具调用），确实存在空窗。本版加入两类边界：

**① 开工反馈（kickoff）—— 事件触发**

| 项 | 说明 |
|:--|:--|
| 触发 | `turn/start` 且**本轮确实由一条新用户消息发起** |
| 守卫 | 用 `pendingUserTask` 标记，`turn/end` 时清空 → 自动续跑/恢复会话时**不重念旧任务**；任务短于 `kickoffMinTaskChars`（默认 4 字，如「继续」）不念 |
| 节流 | **专用短窗口 `kickoffThrottleMs`（默认 400ms）**，不被默认 2500ms 防抖拖累 —— 这才叫"第一时间" |
| 语体 | 专用 system prompt：**先确认收到，再说打算怎么下手（只讲思路方向，禁止编造具体步骤）**，≤45 字 |

**② 静默心跳（progress-heartbeat）—— 唯一的时间触发**

| 项 | 说明 |
|:--|:--|
| 触发 | 本轮**仍在进行** 且 距上次播报 ≥ `silenceHeartbeatMs`（默认 **30000ms**） |
| ⚠️ 关键守卫 | **期间必须确实有活动**（有新工具调用/新事件）。没活动就不报 —— 否则助手真卡住时它会编造"正在努力工作"，比沉默更糟 |
| 优先级 | `low` —— 你正在听别的播报时直接丢弃 |
| 语体 | 专用 system prompt：**说正在做什么、到哪一步**，不下结论、不说"请稍等"套话，≤45 字 |
| 实现 | 插件内 15s 轮询（`min(silenceHeartbeatMs/2, 15s)`），`ctx.effect` 管理生命周期；`silenceHeartbeatMs: 0` 完全关闭 |

### 调整

- `stageToolCalls` 默认 **12 → 8**（里程碑密一点，填住心跳之间的空隙）
- `schedule()` 支持**边界自带节流窗口**（新增 `boundary.throttleMs` 覆盖）
- 规则兜底摘要补两条（LLM 不可用时也有得体的开工/心跳话术）

### 测试

新增 10 项，**44 → 53 项全绿**：开工反馈触发/守卫/短消息/短节流窗口/pendingUserTask 清空；心跳触发/无活动不报/轮次结束不报/关闭开关。

### 部署

`stageToolCalls` 等配置改动**热生效**；但本版改了代码 → **必须重启 DSH**（ESM 按 URL 缓存）。
判据：`cordis_inspect_query` 的 Config 投影里应出现 `announceKickoff` / `silenceHeartbeatMs`。

### 语音引擎切换到 MiniMax 云端

`engine` 指向 `~/.dsh/tools/minimax-speak.sh`，音色选定 `Chinese (Mandarin)_Warm_Girl`。

- 实测 API 往返 **1.0–1.4s**；缓存命中即时；30s 心跳 + 开工反馈叠加后仍在可接受范围
- ✅ **已验证 DSH 能 spawn `.sh` wrapper**（调研阶段唯一未验证的技术点）
- ⚠️ 两个坑已处理：① 插件注入的 `-v <voice>` 由 wrapper 用 `${!#}` 取末位 argv 绕开；
  ② MiniMax 出错也返 HTTP 200，wrapper 校验 `base_resp.status_code`，失败回退 `say`
- 文本会出本机；脱敏表 `~/.dsh/tools/minimax-redact.txt` 已留好但**默认关闭**

### 附：同轮被否决的方案

本地 Kokoro-82M-v1.1-zh（ONNX int8，103 音色，RTF 0.62）—— 用户**亲耳试听后认为中文质量基本不可用**，方案放弃。
已转云端方案调研（MiniMax）。相关残留已清理（释放 595MB）。

## V1.0.2 — 2026-10-01

## V1.0.2 — 2026-10-01

### 背景：真的故障，以及我在排查中连续两次判错

**真实故障**：V1.0.0 / V1.0.1 的语音**从来没有真正响过**。
`playOne` 构造的 spawn 参数漏了契约必填的 `cwd`，`subprocess.spawn()` 同步抛错，
异常被自己的 try/catch 吞掉，只写进不落盘的宿主日志。表现是完全静默。

**我判错了两次，方向相反：**

| 次序 | 我的判断 | 实际 |
|:--|:--|:--|
| ① | 依据契约 + `pgrep` 零命中 → 断定「`cwd` 缺失导致没出声」 | ✅ **对** |
| ② | 用户说"听到了" → 我推翻①，改口"播报一直正常" | ❌ **错**。用户听到的是**我自己手动跑的 `say`**（一次 pgrep 灵敏度测试、一次探针自检），不是插件 |
| ③ | 用探针引擎做受控实验 → 插件侧边界/队列都走到，但**探针零记录** → 引擎从未被调用 | ✅ 回到① |

两次错都同一个毛病：**拿间接信号当直接证据，却没先确认它测的是什么。**
`announce` 只证明"进了队列"，`pgrep` 看不到 DSH 子进程服务拉起的进程，
我明明写下过前一句，却还是顺着它下了结论。

### 变更

**1. spawn 参数补齐为契约合规**（`lib/engine.js` 新增 `buildSpawnSpec`）——**这一条就是真凶**

`SubprocessSpawnSpec` 的契约是：

```ts
export interface SubprocessSpawnSpec {
    argv: readonly string[];
    cwd: string;                 // ← 必填（非 cwd?）
    stdio: SubprocessStdio;
    graceMs: number;
    signal?: AbortSignal | undefined;
    env?: NodeJS.ProcessEnv | undefined;
}
```

原实现漏了 `cwd`，并把 `stdout` 写成 `'ignore'`——而
`SubprocessOutputMode` 只有 `'pipe' | 'inherit' | SubprocessCollect`，
`'ignore'` 仅对 `stdin` 合法。

> 🎯 **这就是真凶**：`spawn` 在 `cwd` 非法时**同步抛错**，异常被吞 → 完全静默。
> 修复后实测（2026-10-01 11:25）：
> 日志出现 `boundary` → `announce`、**无 `speak-error`**，用户**实际听到**播报，
> 音色为 `Lilian`。三重对上（日志 / 无错误 / 人耳）。

新增 `cwd` 配置项（留空 = 用户主目录）。

**2. 播报失败不再静默**

引擎新增 `onError` 回调，失败写入审计日志（`speak-error` 行），
`stats().lastError` 也可读。原因：宿主日志不落盘，
而 `announce` 只表示"已交给队列"，不代表真的出声——这次排查就卡在这个盲区上。

**3. 测试加契约守卫**

`fakeSubprocess` 现在对**每一次** spawn 断言 `assertConformantSpawnSpec`
（cwd 非空、graceMs 为数字、stdout/stderr 不是 `'ignore'`、signal/env 类型正确）。
以后任何漏字段都会在单测阶段失败，不再靠人眼。

测试数 40 → **44**。

### 本次新增的可复用经验

| # | 事实 |
|:--|:--|
| 0 | 🩸 **拿到间接信号先问"它测的到底是什么"，再下结论。** 这一轮我犯了两次相反的错：<br>①`pgrep` 零命中 → 断定没出声（错，该探针看不到 DSH 子进程服务拉起的进程）<br>②用户一句"听到了" → 断定播报正常（错，用户听到的是**我自己手动跑的 `say`**）<br>两次都因为跳过"确认证据指向"这一步。**日志/探针/他人反馈都是间接信号** |
| 1 | **从 DSH 的 bash 工具里 `pgrep` 看不到 DSH 子进程服务拉起的进程。** 实测：探针心跳连续 47 次覆盖整个窗口，`pgrep -x say` 零命中，而同环境下 `pgrep -x WindowServer` / `Finder` 正常可见 |
| 2 | `pgrep` 的灵敏度本身没问题（手动起的 `say` 能被命中），盲区只针对该进程树 |
| 3 | **"进了队列"≠"出声了"。** `announce` 这类日志必须在语义上分开记录，否则无法区分链路问题与引擎问题 |
| 4 | 契约类字段（`cwd`、stdio 模式枚举）应当由**测试断言**守着，而不是靠"能跑就行"——`spawn` 对非法 `cwd` 是**同步抛错**，被自己的 try/catch 吞掉就变成完全静默 |
| 5 | **验证"是否出声"只有两个可靠通道**：应用自身的错误留痕（`speak-error`），或人耳。进程探针和队列日志都不算 |
| 6 | **配置改动能热生效，代码改动不能**。判据：`cordis_inspect_query` 看 Config 投影里有没有新字段 |

## V1.0.1 — 2026-10-01

### 修复：插件在 DSH 里加载失败（`fiberPhase: failed`）

**症状**

```
TypeError: Cannot read properties of undefined (reading 'validate')
    at resolveConfig (cordis/lib/index.js:958:45)
    at Fiber._resolveConfig → Fiber._reload
```

**根因**（自埋的雷，只在 `link:` 安装下引爆）

Cordis 用 Standard Schema 接口校验配置：`runtime.Config["~standard"].validate(config)`。

为了脱离 DSH 跑离线单测，V1.0.0 在**包目录内**放了测试替身
`node_modules/@deepseek-ai/schemastery`。该替身的 `Config` 没有 `~standard` 接口。

- `file:`（拷贝）安装：`files` 字段不含 `node_modules`，替身不会被复制到 profile，
  插件走 DSH 运行时的真库 → 正常。**所以 V1.0.0 在拷贝安装下是好的。**
- `link:`（软链）安装：Node 解析到包的真实路径 `~/code/dsh-stage-speak`，
  于是替身**抢先命中**，把真库顶掉 → `~standard` 缺失 → 加载失败。

**修复**

- 删除包内 `node_modules/`，替身移到 `test/schemastery-stub.mjs`。
- 新增 `test/stub-loader.mjs`：用 Node 的 `module.registerHooks` 把
  `@deepseek-ai/schemastery` 指向替身，仅测试期生效。
- `package.json` 加 `scripts.test` 与 `//no-local-node_modules` 备忘（防止复发）。
- 移除排查期间注入的导入期探针。

**验证**

- 用同一替身复刻 Cordis 第 958 行，**逐字复现**了同一个错误信息。
- 对照真库：`Config["~standard"].validate` 是函数。
- 解析路径对照：修复前包目录内可解析到替身（命中）；修复后与已知可用的
  `dsh-reveal-context` 一样「默认解析失败 → 由 DSH 运行时兜底提供真库」。
- `npm test` → 40 / 40 通过。

### 排查过程中的可复用经验

| 经验 | 说明 |
|:--|:--|
| 拿报错的首选通道 | `plugin_manager set_plugin(...)` 的 `error.diagnostic` 会把 Cordis 的**原始异常 + 调用栈**原样给出。`list_plugins` 只给 `fiberPhase: failed`，不给原因 |
| `fiberPhase` 判活 | `failed` / `active` / `null`，比 `status` 更直接 |
| `status: "unsupported"` | 该条目的 Config 无法投影，通常伴随 fiber 失败 |
| 热重载的边界 | 改**代码**：不重载（ESM 按 URL 缓存）。换**安装方式**（link→file 换 URL）：仍不重载，Loader 按 entry 持有模块记录。**只有重启能真正刷新** |
| 二分定位手段 | 在模块顶层加一条写文件的探针，可区分「import 就崩」与「apply 崩」。用完记得删 |

## V1.0.0 — 2026-10-01

首个可用版本。

### 新增

- **阶段边界判定**（`lib/activity.js`）：监听 `session/event`，识别五类边界 ——
  待办完成（`todo/write` 中 completed 数增加）、轮次结束（`turn/end`）、
  工具报错（`tool/result` 的 `error` 或 `isError`）、等你审批（`approval/asked`）、
  累计步数里程碑（`tool/call` 达到 `stageToolCalls`）。
- **LLM 摘要层**（`lib/summarize.js`）：把最近的活动清单交给该会话自己的模型路由，
  压成 1–2 句中文口语。模型不可用、超时、报错一律**退化为规则摘要**，不会沉默。
- **语音串行队列**（`lib/engine.js`）：同一时刻只跑一个朗读进程；
  普通播报忙时合并成最新一条，高优先级打断当前播报。macOS 走 `say`，Windows 走 PowerShell + System.Speech。
- **文本清洗**（`lib/clean.js`）：剥 Markdown / 表格 / URL / emoji / 代码块，
  超长按句末截断。
- **播报审计日志**（`lib/journal.js`）：`logFile` 记录 `ready` / `boundary` / `announce` 三类行，
  可回看"到底念了什么"。
- **设置页集成**：导出 `Config`，带 `volatile()` 的字段投影到 DSH 设置页。

### 真实数据校准

默认参数由一份真实会话日志（34 轮、4815 行事件、3009 个 zstd 帧）回放得出：

- 原始判定 91 个边界：40 步数里程碑 / 30 轮结束 / 18 工具报错 / 3 待办完成。
- 18 次工具报错中 12 次是 `FsError`，且全部是**按设计可自愈**的观察策略错
  （`FS_NOT_OBSERVED` 先读后写、`FS_STALE_VERSION` 版本过期重放）→ 加入
  `toolErrorIgnoreCodes` 默认过滤。
- 工具报错在真实会话中高频出现 → `toolErrorPriority` 默认由 `high` 降为 `normal`，
  不再打断当前播报。校准后打断性播报 18 → 8。
- 其余 6 次无结构化错误的 `isError`（`skill "x" is unknown` 等）是真实失败，保留播报。

### 验证

- `node test/offline.mjs` —— 40 项离线单测全绿（假 cordis 上下文 + 假子进程，覆盖完整流水线）。
- 真实 `say` 两种 argv（默认音色 / `-v Tingting`）实机出声验证通过。
- 插件装入 `desktop` profile：`fiberPhase: active`，Config schema 完整投影
  （含 `x-cordis.volatile` 标记）。
- 真实会话日志回放：事件形状全部对上（事件行 `{type,seq,time,data}`；
  `todo/write.data.todos[].{content,status}`；`turn/end.data.reason.kind`；
  `tool/call.data.{name,arguments}`）。

### 已知限制

- **新增 bundle 需重启 DSH 才生效**：`dsh.profile.bundles` 的行的 boot 时读取；
  且 ESM 按 URL 缓存，改源码后热重载仍跑旧模块。
- **已存在的会话收不到新挂载**：插件装入后，安装前就已创建的会话不会触发播报，
  重启后所有挂载重建即正常。
- Windows 路径未在真机验证过（argv 构造有单测覆盖，但 SAPI 自然音色的可得性依赖用户环境）。
- 未提供 client 半边，因此没有"点一下重播某条播报"的按钮；`logFile` 是当前的替代。

### 设计取舍

- 只硬依赖 `subprocess`；`llm` 走 `ctx.get()` 可选获取 —— 没有摘要模型时自动退规则摘要，
  而不是让插件加载失败。
- 不声明 `@deepseek-ai/*` 的 peerDependencies：这些包由宿主运行时提供，
  声明只会让 pnpm 安装阶段联网解析并失败。
- 未在 `package.json` 声明任何运行时 `dependencies`，全部零依赖。
