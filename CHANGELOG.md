# CHANGELOG

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
