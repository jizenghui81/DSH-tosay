# dsh-stage-speak 🔊

让 DeepSeek Harness 在**每完成一个阶段**时，用一句人话把进展念出来 —— 而不是把回复原文从头读到尾。

> 你在别处做事，耳机里听到："登录的 bug 修好了，测试也过了，还剩一个边界情况没覆盖。"

## 它和"念最终回复"有什么不同

| | 念最终回复（dsh-speak 等） | 本插件 |
|---|---|---|
| 说什么 | 回复原文，清洗 Markdown 后照念 | **模型把最近的工作压成 1–2 句口语** |
| 何时说 | 一轮结束 | **八类阶段边界**：开工反馈、静默心跳、累计步数、待办完成、轮次结束、出错、等你审批、目标变更 |
| 长文本 | "本次播报内容较长，请自行阅读" | 摘要本来就只有一句话，不存在这个问题 |
| 忙的时候 | 排队 | 普通播报**合并成最新一条**，急事**打断** |

## 工作原理

```
session/event ──► activity.noteEvent      判断"这是不是一个阶段边界"
                     │
                     ├─ throttleMs 静默期合并 + minGapMs 最小间隔
                     ▼
               summarize.summarize        模型压成一句话；失败自动退规则摘要
                     ▼
               engine.speak               串行播报：忙时合并、急事插队
```

五个功能层各自独立、都能单独替换（`lib/index.js` 是编排入口）：

| 文件 | 职责 | 依赖 |
|---|---|---|
| `lib/activity.js` | 活动缓冲 + 阶段边界判定 | 无（纯函数，可离线单测） |
| `lib/summarize.js` | 摘要：LLM 优先，规则兜底 | `llm` 服务（可选） |
| `lib/engine.js` | 语音串行队列 + 平台 argv + 引擎路径解析 | `subprocess` 服务 |
| `lib/clean.js` | Markdown → 可朗读文本 | 无 |
| `lib/journal.js` | 播报审计日志 | `node:fs` |

**底线**：任何一步失败都只记日志。播报是锦上添花，绝不影响会话。

## 安装

**从 GitHub 直装**（纯 ESM、无构建步骤，因此不需要 pnpm 的构建授权）：

```bash
dsh plugin --profile <你的 profile> add github:jizenghui81/DSH-tosay
```

**从本地 checkout 安装**：

```bash
dsh plugin --profile <你的 profile> add /path/to/dsh-stage-speak
```

安装后**需要重启 DSH**：新增 bundle 的行在 boot 时读取，且 ESM 按 URL 缓存。
安装前就已存在的会话也收不到事件，重启后所有挂载重建才正常。

### 环境要求

- DSH `>= 0.1.7-rc.1`（`package.json` 的 `dsh.engines` 声明了确切范围）
- macOS：系统自带 `say`，**开箱即用、无需任何密钥**
- Windows：`powershell` + `System.Speech`（Win11 自带自然语音；Win10 需 NaturalVoiceSAPIAdapter）

## 配置

改动有两个入口，写的是同一份配置：DSH 设置页（本插件导出了带 `volatile()` 的 Config），或 `~/.dsh/profiles/<profile>/cordis.patch.yml` 的顶层行。

```yaml
- id: dsh-stage-speak
  name: dsh-stage-speak
  config:
    logFile: ~/.dsh/dsh-stage-speak.log
    voice: ''
```

⚠️ **层与覆盖**：生效配置按 bundle patch → profile patch → `$DSH_HOME/cordis.patch.yml` → `--patch` 叠加，**后应用的层按行取胜，且 patch 替换目标行的整个 `config`，不做深合并**。所以你在 profile 里写同 id 的顶层行时，那一行的 config 会**整体替换**包内默认值 —— 想保留某项默认，就要在自己的行里重述它。

### 参数

| 参数 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| **播报什么** | | |
| `announceTurnEnd` | `true` | 一轮结束 |
| `announceKickoff` | `true` | 开工反馈：接到新任务第一时间回一句"收到 + 打算怎么做" |
| `kickoffThrottleMs` | `400` | 开工反馈的专用短节流窗口——"第一时间"不能被默认 2500ms 拖累 |
| `kickoffMinTaskChars` | `4` | 任务短于此字数不念（如"继续"） |
| `silenceHeartbeatMs` | `30000` | 静默心跳：本轮进行中且这么久没播报就报一次进展（0 = 关闭）。**期间必须确实有活动**，真卡住时不报 |
| `announceTodoCompleted` | `true` | 待办有项转为完成 |
| `announceApprovals` | `true` | 等你审批（高优先级，会打断） |
| `announceGoalChange` | `false` | 目标变更 |
| `includeSubagents` | `false` | 子代理会话是否也播报（并行跑多个子代理时建议保持关闭） |
| `toolErrorIgnoreCodes` | `["FS_NOT_OBSERVED","FS_STALE_VERSION"]` | 按错误码过滤"按设计可自愈"的工具报错 |
| `toolErrorPriority` | `normal` | `high` 恢复"出错即打断" |
| **节奏** | | |
| `throttleMs` | `2500` | 静默期，连续事件合并成一次播报 |
| `minGapMs` | `6000` | 两次播报最小间隔 |
| `stageToolCalls` | `8` | 累计多少步工具调用播报一次长任务进展 |
| `turnEndMinToolCalls` | `1` | 一轮至少干了几步才值得念（0 = 光聊天也念） |
| **摘要** | | |
| `useLlmSummary` | `true` | 关掉就只用规则摘要 |
| `maxChars` | `120` | 单次朗读字数上限 |
| `summaryProvider` / `summaryModel` | `''` | 留空 = 用该会话自己的模型路由 |
| `llmTimeoutMs` | `15000` | 摘要超时，超时退规则摘要 |
| **声音** | | |
| `voice` | `''` | 留空跟随系统默认朗读音色；填名字则写死 |
| `rate` | `0` | macOS：每分钟词数（默认约 175）；Windows：SAPI `-10..10` |
| `volume` | `100` | 仅 Windows |
| `engine` | `''` | 留空 = macOS `say` / Windows `powershell`；`./x` = 相对**包根**解析；其他按 PATH 解析 |
| **运维** | | |
| `cwd` | `''` | 语音子进程的工作目录，留空 = 用户主目录（契约要求必填） |
| `graceMs` | `4000` | 子进程结束后的宽限期 |
| `speakTimeoutMs` | `120000` | 单句朗读的最长时限，防某个引擎卡死占住队列 |
| `logFile` | `''` | 播报审计日志（制表符分隔，逐行追加）。支持 `~/` 前缀 |
| `logAnnouncements` | `false` | 摘要同时写宿主日志 |

`logFile` / `engine` / `cwd` 三个路径字段支持 `~/` 前缀（插件会展开）——包内默认值因此可以跨机器使用。

### 日志里的七类行

`logFile` 每行是 `时间戳 <TAB> 类别 <TAB> 说明`：

| 类别 | 含义 |
|:--|:--|
| `ready` | 插件挂载成功（启动时一行）。**看不到这行 = 插件根本没加载** |
| `boundary` | 判定到一个阶段边界 |
| `announce` | 已把摘要交给播报队列 —— **注意：这只表示"进了队列"，不表示"出声了"** |
| `coalesced` | 该边界被已挂起的边界合并（同优先级窗口内） |
| `dropped` | 摘要为空，或插件已卸载/重载 |
| `pipeline-error` | 播报流水线抛错，附错误信息 |
| `speak-error` | 播报进程启动/执行失败，附原始错误 |

排查顺序：`ready` → `boundary` → `announce` → `speak-error`。哪一环断了一眼可见。

> **通道契约**：**每个判定过的 `boundary`，最终必定留下
> `announce` / `coalesced` / `dropped` / `pipeline-error` 之一。**
> 单测直接断言 `boundary 数 == announce + dropped + coalesced + pipeline-error`。
>
> 立这条契约的原因：修好之前，被合并和被掐掉的边界都是**静默 return、不留痕**，
> 于是"判定过却没播"在日志里**无法归因**。

> ⚠️ **不要用 `pgrep` 验证播报是否发生。** 实测从 DSH 的 bash 工具里
> `pgrep -x say` 看不到 DSH 子进程服务拉起的进程（心跳连续 47 次覆盖整个窗口仍零命中），
> 而同环境下 `pgrep -x WindowServer`、`Finder` 正常可见。判断出声与否请看
> `speak-error` 行，或者直接听。

## 云端语音引擎（可选）

默认走系统语音：**零配置、纯本地、不需要密钥**。想换更好的音质，可启用随包分发的
MiniMax 引擎：

```yaml
engine: ./engine/minimax-speak.sh
```

`./` 开头的写法相对**包根**解析，所以这个配置在装了本插件的任何机器上都成立，不含用户名与绝对路径。

| 项 | 值 |
|:--|:--|
| 密钥来源 | `MINIMAX_API_KEY` 环境变量（优先）或 `~/.mmx/config.json` 的 `api_key` —— **都在仓库之外** |
| 默认模型 | `speech-2.8-turbo`（改 `~/.dsh/tools/minimax-model.txt` 换，免重启） |
| 默认音色 | `Chinese (Mandarin)_Warm_Girl`（改 `~/.dsh/tools/minimax-voice.txt` 换，免重启） |
| 失败回退 | 网络不通 / 欠费 / 限流 / 任何异常 → **自动退回系统 `say`**，保证必出声 |
| 缓存 | `~/.cache/dsh-stage-speak/<hash>.mp3`，按 文本+模型+音色 哈希；上限 300 个自动修剪 |
| 日志 | `~/.dsh/logs/minimax-speak.log`（`ok` / `cache-hit` / `fallback` / `prune`；`ok` 行末附实际使用的模型） |

配置优先级（高 → 低）：环境变量 → `~/.dsh/tools/minimax-{model,voice}.txt` → **包内** `engine/minimax-{model,voice}.txt` → 内置默认。

### ⚠️ 两个必须知道的坑

1. **插件会注入 `-v <voice>`** —— 引擎侧的 argv 形如 `<wrapper> -v <voice> "文本"`。
   wrapper 用 `${!#}` **取最后一个 argv 当文本**，忽略所有 flag。改引擎时别破坏这个约定。
2. **MiniMax 出错也返回 HTTP 200** —— 必须读 `base_resp.status_code`，否则会写出假的空 mp3 并静默失败。wrapper 已做校验。

### 脱敏

播报文本**会离开本机**。需要时把 `engine/minimax-redact.txt.example` 复制到
`~/.dsh/tools/minimax-redact.txt`，按 `原词=替换词` 一行一条填写。
⚠️ 做的是**全局字符串替换**，**不要放短词或纯数字**（如 `325` 会误伤正常文本）。

## 排障

| 现象 | 原因 / 处置 |
|---|---|
| 装了完全没反应 | 先重启 DSH。新增 bundle 的行在 boot 时读取；已存在的会话不会收到新插件的挂载 |
| 改了源码没生效 | ESM 按 URL 缓存。改代码需重载插件或重启 |
| 完全不响 | 看 `logFile` 有没有写入。有 `boundary` 但既无 `announce` 也无 `coalesced`/`dropped`/`pipeline-error` → 事件没到；`speak-error` 有内容 → 引擎侧问题 |
| 太吵 | 调大 `minGapMs` / `stageToolCalls`，关掉 `announceTurnEnd` |
| 念得不对 | 设 `logAnnouncements: true` 看宿主日志，或看 `logFile` 里实际念出的文本 |
| 云端引擎没生效 | 看 `~/.dsh/logs/minimax-speak.log` 是否有 `fallback` 行——最常见原因是没配密钥 |

## 开发

```bash
pnpm install          # 装 devDependencies（真实 @deepseek-ai/* 包）
npm test              # 59 项离线单测，不需要 DSH
npm run check-secrets # 提交前必跑：密钥与隐私守卫
npm run replay -- <会话日志> --verbose   # 真实会话回放
```

`test/offline.mjs` 用假的 cordis 上下文和假的子进程跑完整流水线，覆盖边界判定、防抖、
优先级插队、LLM 降级、子代理过滤、队列合并、卸载清理、开工反馈与静默心跳的守卫，
以及两组契约断言：**每次 spawn 的 `SubprocessSpawnSpec` 合规性**、**通道留痕完整性**。

## 安全

**本仓库不含任何密钥**，且不接受把密钥写进仓库的做法。提交前请跑 `npm run check-secrets`；
该守卫会把本机真实密钥与真实用户名读入内存逐字比对，确认它们没有出现在仓库里。
细节见 [SECURITY.md](./SECURITY.md)。

## 许可

MIT，见 [LICENSE](./LICENSE)。
