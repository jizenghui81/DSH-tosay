// client.js —— dsh-stage-speak 的浏览器半边：插件页上的配置面板。
//
// 为什么要有它：宿主半边的 34 个配置字段里，30 个标了 `volatile()`，**本来就能在设置页改**，
// 但那是一张扁平键值表，标题是机器命名（`kickoffThrottleMs` 这种）。这张面板把它们按
// "用户意图"分成五组，配上中文标签、说明与当前值，并提供一键恢复默认。
//
// ⚠️ **面板是同一份配置的第二层视图，不是替代**。数据源都是 profile 条目上的那一条记录，
//    所以面板与设置页永远一致；代价是两边都能改。
//
// 本文件是**手写的浏览器 bundle**（无构建步骤），形态与官方模板一致：
//   window.__ModuleLoader__.load({ id, factory(require) })  →  exports.name / inject / apply
// 因此不能用 import 语法，也不依赖任何 Node 内置模块。
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ 官方文档（App 内 `dsh-agent-preset/skills/cordis-plugin-development/`）里三条硬规则，
//    本文件遵守，后续改这个插件也必须遵守：
//
//  1. **不要 `require('@deepseek-ai/dsh-client-ui-primitives')`**，也不要加载任何其它
//     Harness Client 包当模块（`references/practices.md` §UI）。`dsh.client.inject` 只用来
//     排序激活、**不提供模块**；这些包说变就变，而纯 JS 插件没有类型检查，组件一抛错就是
//     `slot entry crashed in '<slot>'`，整块面板直接空掉。控件要自己写，只共享 `--dsw-alias-*` 主题 token。
//  2. **slot 注册用 `key`**（`plugins.bundle.config` 是 keyed slot，缺 key 会抛错）。
//  3. **hook 的键名不要带 `use` 前缀**：宿主用 `standardHookPropName` 自动加
//     （`StageSpeakCard` → props 上的 `useStageSpeakCard`）。写成 `useStageSpeakCard`
//     会被翻成 `useUseStageSpeakCard`，组件拿到 undefined —— 线上实测踩过。
// ─────────────────────────────────────────────────────────────────────────────

window.__ModuleLoader__.load({
	id: 'dsh-stage-speak',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');

		//#region 共享契约
		/** 包名。同时是 Loader 行 id、浏览器注册 id、以及读配置用的 profile 条目 id。 */
		const PLUGIN_ID = 'dsh-stage-speak';
		/** Host 半边导出、浏览器 factory 也返回的插件模块名。 */
		const PLUGIN_NAME = 'stage-speak';
		/** 本插件字典的命名空间，与包名一致。 */
		const LOCALE_NS = PLUGIN_ID;
		/** 双工档位字段名。 */
		const MODE_FIELD = 'mode';
		/** 三个档位，顺序即 UI 顺序。 */
		const MODES = ['off', 'half', 'full', 'mute'];
		/** 缺省档位：**原始**——不启用双工，行为与不加双工之前完全一致。 */
		const DEFAULT_MODE = 'off';
		/** 档位 → 按钮文案键。四档共用一张表，避免"新加一档忘了改渲染"这类错。 */
		const MODE_LABEL_KEY = { off: 'modeOff', half: 'modeHalf', full: 'modeFull', mute: 'modeMute' };
		/** 档位 → 该档的说明文案键。 */
		const MODE_HINT_KEY = { off: 'modeOffHint', half: 'modeHalfHint', full: 'modeFullHint', mute: 'modeMuteHint' };

		/**
		 * 把未知形状的值收敛成合法档位。
		 * @param value - 配置里的原始值。
		 * @returns 'off' | 'half' | 'full'。
		 */
		function normalizeMode(value) {
			return MODES.includes(value) ? value : DEFAULT_MODE;
		}
		//#endregion

		//#region 字段清单
		/**
		 * 面板的字段清单。**顺序即渲染顺序**，也是"恢复全部默认"的遍历顺序。
		 *
		 * 四个技术字段刻意不进面板：
		 *   `engine`（引擎可执行文件路径）· `cwd`（子进程工作目录）—— 配错就彻底哑掉；
		 *   `logFile`（日志落盘路径）· `toolErrorIgnoreCodes`（工具错误码白名单）—— 纯排障用。
		 * 它们仍在设置页可改。
		 *
		 * @type {Array<{id: string, title: string, hint: string, fields: Array<object>}>}
		 */
		const GROUPS = [
			{
				id: 'core',
				title: 'coreTitle',
				hint: 'coreHint',
				fields: [
					{ field: 'enabled', kind: 'boolean', label: 'enabled', hint: 'enabledHint' },
					{ field: MODE_FIELD, kind: 'mode', label: 'mode', hint: 'modeHint' },
					{ field: 'bargeInEnabled', kind: 'boolean', label: 'bargeInEnabled', hint: 'bargeInEnabledHint' },
					{ field: 'bargeInOverDb', kind: 'number', min: 3, max: 40, label: 'bargeInOverDb', hint: 'bargeInOverDbHint' },
					{ field: 'bargeInOverDbPlaying', kind: 'number', min: 3, max: 40, label: 'bargeInOverDbPlaying', hint: 'bargeInOverDbPlayingHint' },
					{ field: 'bargeInReleaseMs', kind: 'number', min: 100, max: 3000, label: 'bargeInReleaseMs', hint: 'bargeInReleaseMsHint' },
					{ field: 'duplexEnabled', kind: 'boolean', label: 'duplexEnabled', hint: 'duplexEnabledHint' },
					{ field: 'duplexLanguage', kind: 'string', label: 'duplexLanguage', hint: 'duplexLanguageHint' },
					{ field: 'duplexInjectMode', kind: 'enum', values: ['steer', 'followup'], label: 'duplexInjectMode', hint: 'duplexInjectModeHint' },
					{ field: 'duplexEchoGuard', kind: 'boolean', label: 'duplexEchoGuard', hint: 'duplexEchoGuardHint' },
					{ field: 'announceTurnEnd', kind: 'boolean', label: 'announceTurnEnd', hint: 'announceTurnEndHint' },
					{ field: 'announceTurnEndOnChat', kind: 'boolean', label: 'announceTurnEndOnChat', hint: 'announceTurnEndOnChatHint' },
					{ field: 'useLlmSummary', kind: 'boolean', label: 'useLlmSummary', hint: 'useLlmSummaryHint' },
				],
			},
			{
				id: 'content',
				title: 'contentTitle',
				hint: 'contentHint',
				fields: [
					{ field: 'announceKickoff', kind: 'boolean', label: 'announceKickoff', hint: 'announceKickoffHint' },
					{ field: 'announceTodoCompleted', kind: 'boolean', label: 'announceTodoCompleted', hint: 'announceTodoCompletedHint' },
					{ field: 'announceApprovals', kind: 'boolean', label: 'announceApprovals', hint: 'announceApprovalsHint' },
					{ field: 'announceGoalChange', kind: 'boolean', label: 'announceGoalChange', hint: 'announceGoalChangeHint' },
					{ field: 'includeSubagents', kind: 'boolean', label: 'includeSubagents', hint: 'includeSubagentsHint' },
				],
			},
			{
				id: 'voice',
				title: 'voiceTitle',
				hint: 'voiceHint',
				fields: [
					{ field: 'voice', kind: 'string', label: 'voice', hint: 'voiceHint' },
					{ field: 'voiceAlt', kind: 'string', label: 'voiceAlt', hint: 'voiceAltHint' },
					{ field: 'rate', kind: 'number', min: 0, max: 400, label: 'rate', hint: 'rateHint' },
					{ field: 'volume', kind: 'number', min: 0, max: 100, label: 'volume', hint: 'volumeHint' },
					{ field: 'summaryProvider', kind: 'string', label: 'summaryProvider', hint: 'summaryProviderHint' },
					{ field: 'summaryModel', kind: 'string', label: 'summaryModel', hint: 'summaryModelHint' },
					{ field: 'maxChars', kind: 'number', min: 20, max: 600, label: 'maxChars', hint: 'maxCharsHint' },
				],
			},
			{
				id: 'pace',
				title: 'paceTitle',
				hint: 'paceHint',
				fields: [
					{ field: 'silenceHeartbeatMs', kind: 'number', min: 0, label: 'silenceHeartbeatMs', hint: 'silenceHeartbeatMsHint' },
					{ field: 'throttleMs', kind: 'number', min: 0, label: 'throttleMs' },
					{ field: 'minGapMs', kind: 'number', min: 0, label: 'minGapMs' },
					{ field: 'stageToolCalls', kind: 'number', min: 1, label: 'stageToolCalls' },
					{ field: 'turnEndMinToolCalls', kind: 'number', min: 0, label: 'turnEndMinToolCalls' },
					{ field: 'kickoffThrottleMs', kind: 'number', min: 0, label: 'kickoffThrottleMs' },
					{ field: 'kickoffMinTaskChars', kind: 'number', min: 0, label: 'kickoffMinTaskChars' },
					{ field: 'llmTimeoutMs', kind: 'number', min: 1000, label: 'llmTimeoutMs' },
					{ field: 'toolErrorPriority', kind: 'enum', values: ['normal', 'high'], label: 'toolErrorPriority' },
				],
			},
			{
				id: 'advanced',
				title: 'advancedTitle',
				hint: 'advancedHint',
				fields: [
					{ field: 'modelWaitMinGapMs', kind: 'number', min: 0, label: 'modelWaitMinGapMs' },
					{ field: 'graceMs', kind: 'number', min: 0, label: 'graceMs' },
					{ field: 'speakTimeoutMs', kind: 'number', min: 1000, label: 'speakTimeoutMs' },
					{ field: 'logAnnouncements', kind: 'boolean', label: 'logAnnouncements' },
				],
			},
		];

		/** 拍平后的全部字段描述。 */
		const ALL_SPECS = GROUPS.flatMap((group) => group.fields);
		/** 字段名 → 描述。 */
		const SPEC_BY_FIELD = new Map(ALL_SPECS.map((spec) => [spec.field, spec]));
		//#endregion

		//#region 字典
		const zh = {
			description: '阶段摘要语音播报：助手每完成一个阶段就用一句人话念出来。这里集中调整开关、内容、声音与节奏。',
			coreTitle: '核心',
			coreHint: '每天会动到的开关。',
			contentTitle: '念什么',
			contentHint: '决定哪些事件值得开口。',
			voiceTitle: '声音与摘要',
			voiceHint: '用什么声音念、由谁压成一句话。',
			paceTitle: '节奏',
			paceHint: '多久报一次。数值单位一律是毫秒。',
			advancedTitle: '高级',
			advancedHint: '极少动它，改错会安静或占资源。',
			enabled: '启用语音播报',
			enabledHint: '关闭后不再注册任何监听，等于完全停用。',
			mode: '双工档位',
			modeHint: '决定麦克风是否参与，以及你说话时助手如何让路。',
			modeOff: '原始',
			modeOffHint: '照旧播报，与不加双工之前完全一致；不启用麦克风，也不监听你说话。',
			modeMute: '静音',
			modeMuteHint: '完全停用：不播报，也不使用麦克风（等价于关掉上面的总开关）。',
			modeHalf: '半双工',
			modeHalfHint: '只检测你是否开口：你一说话就暂停播报让路，输入仍走你自己的输入法。',
			modeFull: '全双工',
			modeFullHint: '在半双工之上，把你说的话交给本机识别，识别文本作为你的消息插进当前会话（需要本机已装本地识别服务）。',
			bargeInEnabled: '你一开口就让路',
			bargeInEnabledHint: '播报期间检测到你在说话，立刻停下不念了（需要麦克风权限；半双工与全双工档都起作用）。',
			duplexEnabled: '全双工识别与注入',
			duplexEnabledHint: '全双工档下是否真的识别并注入。关掉则退化成半双工：只让路，不识别。',
			duplexLanguage: '识别语言',
			duplexLanguageHint: '本机识别服务的语言提示：auto / zh / en / yue / ja / ko（填其它值会每次识别都失败）。',
			duplexInjectMode: '识别文本怎么进会话',
			duplexInjectModeHint: 'steer = 插进当前回合的下一个步骤边界（不打断正在飞的模型请求）；followup = 作为新的一轮排在后面。',
			duplexEchoGuard: '防止把自己的话当成你说的',
			duplexEchoGuardHint: '播报会被麦克风收回去、又被识别成你的话——实测出现过重复注入。开着时有两层防御：播完后 1.5 秒内维持严格判定，以及与最近念过的内容做相似度比对。关掉可能重复注入。',
			bargeInOverDb: '安静时多大声算开口',
			bargeInOverDbHint: '相对环境底噪高出多少 dB 才算你在说话。太小会被环境噪声误触发，太大会漏掉轻声起头。',
			bargeInOverDbPlaying: '播报中多大声算开口',
			bargeInOverDbPlayingHint: '播报期间用更严的门限，避免把自己外放的声音当成你在说话（自打断）。外放回声实测约抬升 5.5 dB，故默认比上面高 5 dB。',
			bargeInReleaseMs: '说完了的判定时长',
			bargeInReleaseMsHint: '安静持续这么久才认为你说完了。太短会把句中停顿当成结束。',
			announceTurnEnd: '每轮结束都收尾',
			announceTurnEndHint: '一轮做完念一句「这一轮结束了」。',
			announceTurnEndOnChat: '纯聊天轮次也收尾',
			announceTurnEndOnChatHint: '不调用任何工具的闲聊轮次，同样给一个结束信号。',
			useLlmSummary: '用模型压成一句话',
			useLlmSummaryHint: '关掉后只做规则摘要，不额外调用摘要模型。',
			announceKickoff: '开工先应一声',
			announceKickoffHint: '接到任务的第一时间口头确认「收到 + 思路」。',
			announceTodoCompleted: '待办完成时播报',
			announceTodoCompletedHint: '每完成一条 todo 念一次。',
			announceApprovals: '等你审批时提醒',
			announceApprovalsHint: '需要你拍板时用高优先级提醒，会打断当前播报。',
			announceGoalChange: '目标变化时播报',
			announceGoalChangeHint: '目标建立、修改、完成时念一句。',
			includeSubagents: '子代理也播报',
			includeSubagentsHint: '把子代理的活动一起纳入播报，默认关闭以免嘈杂。',
			voice: '主音色',
			voiceHint: 'MiniMax 音色 ID；留空则用 ~/.dsh/tools/minimax-voice.txt 里的值。',
			voiceAlt: '备用音色',
			voiceAltHint: '多会话并行时给新开的会话用；留空即关闭该功能（不能填 macOS say 的音色名）。',
			rate: '语速',
			rateHint: 'macOS 引擎的语速参数；0 表示用引擎默认。',
			volume: '音量',
			volumeHint: '仅 Windows 引擎使用；macOS 跟随系统音量。',
			summaryProvider: '摘要模型提供方',
			summaryProviderHint: '留空 = 跟随会话当前模型。',
			summaryModel: '摘要模型',
			summaryModelHint: '留空 = 跟随会话当前模型。',
			maxChars: '播报最长字数',
			maxCharsHint: '摘要文本的上限，超出会被截断。',
			silenceHeartbeatMs: '静默心跳间隔',
			silenceHeartbeatMsHint: '本轮在跑但太久没出声，就报一次进展；0 = 关闭。',
			throttleMs: '事件合并窗口',
			throttleMsHint: '这段时间内的多次事件合成一条，避免刷屏。',
			minGapMs: '两条播报最小间隔',
			minGapMsHint: '两条播报之间至少间隔这么久。',
			stageToolCalls: '几次工具算一个阶段',
			stageToolCallsHint: '累计这么多次工具调用就播一次阶段进展。',
			turnEndMinToolCalls: '收尾播报的最低工具数',
			turnEndMinToolCallsHint: '少于这个工具数的轮次不做摘要收尾。',
			kickoffThrottleMs: '开工确认节流',
			kickoffThrottleMsHint: '连续任务之间，开工确认的最小间隔。',
			kickoffMinTaskChars: '开工确认的最短指令',
			kickoffMinTaskCharsHint: '短于这个字数的指令不触发开工确认。',
			llmTimeoutMs: '摘要模型超时',
			llmTimeoutMsHint: '超时即退化为规则摘要，不会卡住播报。',
			toolErrorPriority: '工具报错的优先级',
			toolErrorPriorityHint: 'normal 不打断当前播报；high 会打断。',
			modelWaitMinGapMs: '等模型时的续报下限',
			modelWaitMinGapMsHint: '等模型期间两次续报的最小间隔；0 = 与工具心跳同频。',
			graceMs: '子进程优雅退出宽限',
			graceMsHint: '停播时给引擎进程的退出宽限时间。',
			speakTimeoutMs: '单次播报超时',
			speakTimeoutMsHint: '防止某个引擎卡死占住播报队列。',
			logAnnouncements: '把播报写进日志',
			logAnnouncementsHint: '排障时打开；会产生持续增长的日志文件。',
			restoreAll: '恢复全部默认',
			restoreAllHint: '把上面所有字段重置为插件内置默认值，然后点保存生效。',
			overridden: '已自定义',
			resetOne: '恢复',
			save: '保存',
			saving: '保存中…',
			discard: '放弃',
			saved: '已保存',
			readOnly: '本部署以只读方式保存设置。',
			unavailable: '插件当前未加载，无法读取配置。',
			saveFailed: '本部署没有接受这些值，已保留供你修改。',
			invalidNumber: '请填一个合法数字；在改回合法值之前，这一项不会被保存。',
			loading: '正在读取配置…',
		};
		const en = {
			description: 'Spoken stage summaries: the assistant says each finished stage out loud in one line. Everything tunable lives here.',
			coreTitle: 'Core',
			coreHint: 'The switches you touch daily.',
			contentTitle: 'What to announce',
			contentHint: 'Which events deserve a spoken line.',
			voiceTitle: 'Voice and summary',
			voiceHint: 'Who says it, and who condenses it into one line.',
			paceTitle: 'Pacing',
			paceHint: 'How often it speaks. Every value is in milliseconds.',
			advancedTitle: 'Advanced',
			advancedHint: 'Rarely touched; a wrong value can silence or cost resources.',
			enabled: 'Enable spoken announcements',
			enabledHint: 'Turning this off unregisters every listener, fully disabling the plugin.',
			mode: 'Duplex mode',
			modeHint: 'Whether the microphone participates, and how the assistant yields when you speak.',
			modeOff: 'Original',
			modeOffHint: 'Announce as before, exactly like having no duplex at all: no microphone, no listening.',
			modeMute: 'Muted',
			modeMuteHint: 'Fully disabled: no announcements and no microphone (same as the master switch above).',
			modeHalf: 'Half duplex',
			modeHalfHint: 'Voice-activity only: it pauses playback the moment you speak; you still type with your own input method.',
			modeFull: 'Full duplex',
			modeFullHint: 'On top of half duplex, your speech is transcribed locally and the text is injected into the current session as your message (requires the local recognition service).',
			bargeInEnabled: 'Yield when you start speaking',
			bargeInEnabledHint: 'Stops the announcement as soon as it hears you talk (needs microphone permission; applies in half and full duplex).',
			duplexEnabled: 'Full-duplex recognition and injection',
			duplexEnabledHint: 'Whether full duplex really transcribes and injects. Off degrades to half duplex: it yields, but never recognises.',
			duplexLanguage: 'Recognition language',
			duplexLanguageHint: 'Language hint for the local recogniser: auto / zh / en / yue / ja / ko (anything else fails every recognition).',
			duplexInjectMode: 'How recognised text enters the session',
			duplexInjectModeHint: 'steer = insert at the next step boundary of the current turn (does not interrupt an in-flight model request); followup = queue as a new turn.',
			duplexEchoGuard: 'Do not mistake its own speech for yours',
			duplexEchoGuardHint: 'The announcement is picked up by the microphone and re-recognised as your words; duplicate injection was observed on real hardware. On: two layers of defence, a strict threshold for 1.5 s after playback plus similarity against what it just said. Off: duplicates may come back.',
			bargeInOverDb: 'How loud counts as speech (idle)',
			bargeInOverDbHint: 'Decibels above the ambient floor that count as you speaking. Too small triggers on room noise; too large misses a quiet start.',
			bargeInOverDbPlaying: 'How loud counts as speech (during playback)',
			bargeInOverDbPlayingHint: 'A stricter threshold while the announcement plays, so it does not mistake its own speaker output for you. Measured speaker echo adds about 5.5 dB, hence the default +5 dB.',
			bargeInReleaseMs: 'Silence length that ends a sentence',
			bargeInReleaseMsHint: 'How long it must stay quiet before your sentence is considered finished. Too short splits sentences at pauses.',
			announceTurnEnd: 'Announce every turn end',
			announceTurnEndHint: 'Say "this turn is done" when a turn finishes.',
			announceTurnEndOnChat: 'Announce chat-only turns',
			announceTurnEndOnChatHint: 'Chat turns with no tool calls still get a closing signal.',
			useLlmSummary: 'Condense with a model',
			useLlmSummaryHint: 'Off falls back to rule-based summaries without an extra model call.',
			announceKickoff: 'Acknowledge new tasks',
			announceKickoffHint: 'Confirm "got it, here is the plan" as soon as a task arrives.',
			announceTodoCompleted: 'Announce completed todos',
			announceTodoCompletedHint: 'Speak once each time a todo is completed.',
			announceApprovals: 'Announce approval waits',
			announceApprovalsHint: 'High priority: it interrupts the current announcement.',
			announceGoalChange: 'Announce goal changes',
			announceGoalChangeHint: 'Speak when a goal is created, edited, or completed.',
			includeSubagents: 'Include subagents',
			includeSubagentsHint: 'Fold subagent activity into announcements; off by default to avoid noise.',
			voice: 'Primary voice',
			voiceHint: 'MiniMax voice id; empty uses ~/.dsh/tools/minimax-voice.txt.',
			voiceAlt: 'Alternate voice',
			voiceAltHint: 'Used by newly opened sessions when several run in parallel; empty disables it (not a macOS say voice name).',
			rate: 'Speaking rate',
			rateHint: 'macOS engine rate; 0 keeps the engine default.',
			volume: 'Volume',
			volumeHint: 'Windows engine only; macOS follows the system volume.',
			summaryProvider: 'Summary provider',
			summaryProviderHint: 'Empty follows the session model.',
			summaryModel: 'Summary model',
			summaryModelHint: 'Empty follows the session model.',
			maxChars: 'Max spoken characters',
			maxCharsHint: 'Upper bound for the summary text; longer text is truncated.',
			silenceHeartbeatMs: 'Silence heartbeat',
			silenceHeartbeatMsHint: 'Report progress if a running turn stays quiet this long; 0 disables it.',
			throttleMs: 'Event merge window',
			throttleMsHint: 'Events within this window are merged into one line.',
			minGapMs: 'Minimum gap between lines',
			minGapMsHint: 'At least this long between two announcements.',
			stageToolCalls: 'Tool calls per stage',
			stageToolCallsHint: 'Announce a stage once this many tool calls accumulate.',
			turnEndMinToolCalls: 'Minimum tool calls for a closing line',
			turnEndMinToolCallsHint: 'Turns with fewer tool calls skip the summary closing line.',
			kickoffThrottleMs: 'Kickoff throttle',
			kickoffThrottleMsHint: 'Minimum gap between two task acknowledgements.',
			kickoffMinTaskChars: 'Shortest task to acknowledge',
			kickoffMinTaskCharsHint: 'Instructions shorter than this do not trigger an acknowledgement.',
			llmTimeoutMs: 'Summary model timeout',
			llmTimeoutMsHint: 'On timeout it falls back to rule-based summaries rather than blocking.',
			toolErrorPriority: 'Tool error priority',
			toolErrorPriorityHint: 'normal does not interrupt; high interrupts the current line.',
			modelWaitMinGapMs: 'Model-wait repeat floor',
			modelWaitMinGapMsHint: 'Minimum gap between model-wait repeats; 0 matches the tool heartbeat.',
			graceMs: 'Process grace period',
			graceMsHint: 'Time given to the speech process to exit when stopping.',
			speakTimeoutMs: 'Single announcement timeout',
			speakTimeoutMsHint: 'Prevents one stuck engine from holding the queue.',
			logAnnouncements: 'Log announcements',
			logAnnouncementsHint: 'For troubleshooting; grows a log file continuously.',
			restoreAll: 'Restore all defaults',
			restoreAllHint: 'Reset every field above to the plugin defaults, then press Save.',
			overridden: 'Overridden',
			resetOne: 'Reset',
			save: 'Save',
			saving: 'Saving...',
			discard: 'Discard',
			saved: 'Saved',
			readOnly: 'This deployment stores settings read-only.',
			unavailable: 'This plugin is not loaded, so it cannot be read right now.',
			saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
			invalidNumber: 'Enter a valid number; this field is not saved until it is.',
			loading: 'Reading settings...',
		};
		//#endregion

		//#region 值编解码
		/**
		 * 把配置里的值编成输入框要显示的文本。
		 * @param spec - 字段描述。
		 * @param value - 配置值。
		 * @returns 文本；无法表示时返回空串。
		 */
		function encodeValue(spec, value) {
			if (value === undefined || value === null) return '';
			if (spec.kind === 'boolean') return value === true ? 'true' : (value === false ? 'false' : '');
			if (spec.kind === 'number') return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
			if (spec.kind === 'enum') return spec.values.includes(value) ? value : '';
			if (spec.kind === 'mode') return normalizeMode(value);
			return typeof value === 'string' ? value : '';
		}

		/**
		 * 把输入框文本解码成配置值。**非法值返回 undefined = 不写入**，避免脏值进配置。
		 * @param spec - 字段描述。
		 * @param text - 输入框文本。
		 * @returns 配置值，或 undefined 表示不接受。
		 */
		function decodeValue(spec, text) {
			if (spec.kind === 'boolean') {
				if (text === 'true') return true;
				if (text === 'false') return false;
				return undefined;
			}
			if (spec.kind === 'number') {
				const trimmed = String(text).trim();
				if (trimmed === '') return undefined;
				const value = Number(trimmed);
				if (!Number.isFinite(value)) return undefined;
				if (spec.min !== undefined && value < spec.min) return undefined;
				if (spec.max !== undefined && value > spec.max) return undefined;
				return value;
			}
			if (spec.kind === 'enum') return spec.values.includes(text) ? text : undefined;
			if (spec.kind === 'mode') return MODES.includes(text) ? text : undefined;
			return String(text);
		}
		//#endregion

		//#region 控件
		/** createElement 短写：本 bundle 不编译 JSX。 */
		const el = (type, props, ...children) => React.createElement.apply(null, [type, props].concat(children));

		/**
		 * 开关控件（照 `role="switch"` 的无障碍约定手写，不依赖官方组件）。
		 * @param props - { checked, disabled, onToggle, label }
		 * @returns React 元素。
		 */
		function Switch(props) {
			return el('button', {
				type: 'button',
				role: 'switch',
				'aria-checked': props.checked,
				'aria-label': props.label,
				className: `dss-switch${props.checked ? ' dss-switch-on' : ''}`,
				disabled: props.disabled,
				onClick: () => {
					props.onToggle(!props.checked);
				},
			}, el('span', { className: 'dss-switch-knob' }));
		}

		/**
		 * 一行字段的公共外壳：标签 + 右侧控件 + 说明 + 覆盖徽标。
		 * @param props - 字段行属性。
		 * @param control - 右侧控件。
		 * @param body - 控件下方的补充内容。
		 * @returns React 元素。
		 */
		function FieldRow(props, control, body) {
			const badges = props.overridden
				? el('span', { className: 'dss-badges' },
					el('span', { className: 'dss-tag' }, props.overriddenLabel),
					el('button', {
						type: 'button',
						className: 'dss-reset',
						disabled: props.disabled,
						onClick: props.onReset,
					}, props.resetLabel))
				: null;
			return el('div', { className: 'dss-field' },
				el('div', { className: 'dss-head' },
					el('label', { className: 'dss-label', htmlFor: props.id }, props.label),
					badges,
					control),
				props.hint === undefined ? null : el('p', { className: 'dss-hint' }, props.hint),
				body ?? null);
		}
		//#endregion

		//#region 面板组件
		/**
		 * 造出插件页面板组件。
		 * @param deps - { t, snapshot, subscribe, mutate }
		 * @returns 面板组件。
		 */
		function createStageSpeakCard(deps) {
			/**
			 * 面板组件。
			 * @param props - 宿主传入的 props（含注入的 hook 与动作）。
			 * @returns React 元素。
			 */
			return function StageSpeakCard(props) {
				const { t } = props;
				if (props.view === 'summary') return t('description');

				// 宿主注入的快照 hook：键名在注册处是 `StageSpeakCard`，宿主会给它加 `use` 前缀。
				const scope = props.useStageSpeakCard((value) => value);
				const [staged, setStaged] = React.useState({});
				const [invalid, setInvalid] = React.useState({});
				const [saving, setSaving] = React.useState(false);
				const [failed, setFailed] = React.useState(false);

				const status = scope?.status;
				const writable = scope?.writable === true && status === 'ready';
				const user = (scope?.user ?? {});
				const values = (scope?.value ?? {});

				/** 当前应该显示的文本：本地草稿优先，否则取配置值。 */
				const textOf = (spec) => (staged[spec.field] !== undefined ? staged[spec.field] : encodeValue(spec, values[spec.field]));

				/** 暂存一次编辑；非法值只留在输入框里，不进草稿。 */
				const stage = (spec, raw) => {
					const decoded = decodeValue(spec, raw);
					setStaged((prev) => ({ ...prev, [spec.field]: raw }));
					setInvalid((prev) => ({ ...prev, [spec.field]: decoded === undefined }));
					setFailed(false);
				};

				/** 该字段是否有用户自定义值。 */
				const isOverridden = (spec) => user[spec.field] !== undefined;

				/** 已改动的字段（与当前配置值不同）。 */
				const dirtyFields = ALL_SPECS.filter((spec) => {
					const raw = staged[spec.field];
					if (raw === undefined) return false;
					const decoded = decodeValue(spec, raw);
					if (decoded === undefined) return true; // 非法也算脏，让保存按钮可见但保存被拒
					return encodeValue(spec, values[spec.field]) !== raw;
				});
				const hasDirty = dirtyFields.length > 0;

				/** 保存：把所有改动合成一次 mutate。 */
				const save = async () => {
					if (!writable || saving) return;
					const ops = [];
					for (const spec of dirtyFields) {
						const decoded = decodeValue(spec, staged[spec.field]);
						if (decoded === undefined) continue;
						ops.push({ op: 'set', path: [spec.field], value: decoded });
					}
					if (ops.length === 0) return;
					setSaving(true);
					try {
						const landed = await deps.mutate(ops, scope.revision);
						if (landed) {
							setStaged({});
							setInvalid({});
							setFailed(false);
						} else {
							setFailed(true);
						}
					} catch {
						setFailed(true);
					} finally {
						setSaving(false);
					}
				};

				/** 放弃：清掉本地草稿。 */
				const discard = () => {
					setStaged({});
					setInvalid({});
					setFailed(false);
				};

				/** 恢复单个字段为默认（即删掉用户覆盖值）。 */
				const resetOne = (spec) => {
					setStaged((prev) => {
						const next = { ...prev };
						delete next[spec.field];
						return next;
					});
					setInvalid((prev) => {
						const next = { ...prev };
						delete next[spec.field];
						return next;
					});
					void deps.mutate([{ op: 'unset', path: [spec.field] }], scope.revision);
				};

				/** 恢复全部：把 30 个字段的覆盖值一次性删掉。 */
				const resetAll = () => {
					setStaged({});
					setInvalid({});
					const ops = ALL_SPECS.filter((spec) => isOverridden(spec)).map((spec) => ({ op: 'unset', path: [spec.field] }));
					if (ops.length > 0) void deps.mutate(ops, scope.revision);
				};

				/**
				 * 渲染一个字段行。
				 * @param spec - 字段描述。
				 * @returns React 元素。
				 */
				const renderField = (spec) => {
					const id = `plugin-config-${PLUGIN_ID}-${spec.field}`;
					const shared = {
						key: spec.field,
						id,
						label: t(spec.label),
						hint: spec.hint === undefined ? undefined : t(spec.hint),
						overridden: isOverridden(spec),
						overriddenLabel: t('overridden'),
						resetLabel: t('resetOne'),
						disabled: !writable,
						onReset: () => resetOne(spec),
					};
					if (spec.kind === 'boolean') {
						return FieldRow(shared, el(Switch, {
							checked: textOf(spec) === 'true',
							disabled: !writable,
							label: t(spec.label),
							onToggle: (next) => stage(spec, next ? 'true' : 'false'),
						}));
					}
					if (spec.kind === 'mode') {
						const current = normalizeMode(textOf(spec));
						const group = el('div', { className: 'dss-modes', role: 'radiogroup', 'aria-label': t('mode') },
							MODES.map((mode) => el('button', {
								key: mode,
								type: 'button',
								role: 'radio',
								'aria-checked': mode === current,
								className: `dss-mode${mode === current ? ' dss-mode-on' : ''}`,
								disabled: !writable,
								onClick: () => stage(spec, mode),
							}, t(MODE_LABEL_KEY[mode]))));
						const hints = Object.fromEntries(MODES.map((m) => [m, t(MODE_HINT_KEY[m])]));
						return FieldRow(shared, group, el('p', { className: 'dss-mode-hint' }, hints[current]));
					}
					if (spec.kind === 'enum') {
						return FieldRow(shared, el('select', {
							id,
							className: 'dss-input dss-select',
							value: textOf(spec),
							disabled: !writable,
							onChange: (event) => stage(spec, event.target.value),
						}, spec.values.map((option) => el('option', { key: option, value: option }, option))));
					}
					const body = invalid[spec.field] === true
						? el('p', { className: 'dss-invalid' }, t('invalidNumber'))
						: null;
					return FieldRow(shared, el('input', {
						id,
						className: 'dss-input',
						type: spec.kind === 'number' ? 'number' : 'text',
						min: spec.min,
						max: spec.max,
						value: textOf(spec),
						disabled: !writable,
						spellCheck: false,
						onChange: (event) => stage(spec, event.target.value),
					}), body);
				};

				if (status === 'loading' || status === undefined) {
					return el('p', { className: 'dss-hint' }, t('loading'));
				}
				if (status === 'unavailable') {
					return el('p', { className: 'dss-hint' }, t('unavailable'));
				}

				const sections = GROUPS.map((group) => el('section', { key: group.id, className: 'dss-group' },
					el('div', { className: 'dss-group-head' },
						el('h3', { className: 'dss-group-title' }, t(group.title)),
						el('span', { className: 'dss-group-hint' }, t(group.hint))),
					el('div', { className: 'dss-fields' }, group.fields.map(renderField))));

				const footer = el('div', { className: 'dss-footer' },
					el('button', {
						type: 'button',
						className: 'dss-btn dss-btn-primary',
						disabled: !writable || !hasDirty || saving,
						onClick: () => { void save(); },
					}, saving ? t('saving') : t('save')),
					el('button', {
						type: 'button',
						className: 'dss-btn',
						disabled: !hasDirty || saving,
						onClick: discard,
					}, t('discard')),
					el('button', {
						type: 'button',
						className: 'dss-btn',
						disabled: !writable || saving,
						onClick: resetAll,
					}, t('restoreAll')),
					el('span', { className: 'dss-group-hint' }, t('restoreAllHint')),
					failed ? el('span', { className: 'dss-invalid' }, t('saveFailed')) : null,
					!writable && status === 'ready' ? el('span', { className: 'dss-group-hint' }, t('readOnly')) : null);

				return el('div', { className: 'dss-root' }, sections, footer);
			};
		}
		//#endregion

		//#region 样式
		/** 样式标签的 data-plugin-css 标记，供宿主识别与热替换。 */
		const STYLE_MARK = `${PLUGIN_ID}/styles`;
		/** 面板样式。颜色只用 --dsw-alias-* 语义 token，跟随明暗主题（文档 §UI 的硬要求）。 */
		const css = `
.dss-root { display: flex; flex-direction: column; gap: 18px; }
.dss-group { display: flex; flex-direction: column; gap: 6px; }
.dss-group-head { display: flex; align-items: baseline; gap: 8px; }
.dss-group-title { margin: 0; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dss-group-hint { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.dss-fields { display: flex; flex-direction: column; gap: 10px; }
.dss-field { display: flex; flex-direction: column; gap: 3px; }
.dss-head { display: flex; align-items: center; gap: 8px; }
.dss-label { font-size: 13px; color: var(--dsw-alias-label-primary); }
.dss-badges { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; }
.dss-tag {
  font-size: 11px; line-height: 16px; padding: 0 6px; border-radius: 4px;
  background: var(--dsw-alias-bg-secondary); color: var(--dsw-alias-label-secondary);
}
.dss-reset {
  border: none; background: none; padding: 0; cursor: pointer;
  color: var(--dsw-alias-label-tertiary); font-size: 12px; text-decoration: underline;
}
.dss-reset:disabled { cursor: default; opacity: .5; }
.dss-hint { margin: 0; font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-tertiary); }
.dss-mode-hint { margin: 0; font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-secondary); }
.dss-invalid { font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-error, #d33); }
.dss-input {
  margin-left: auto; min-width: 180px; max-width: 260px; box-sizing: border-box;
  padding: 3px 8px; border: 1px solid var(--dsw-alias-border-secondary);
  border-radius: 4px; background: var(--dsw-alias-bg-primary);
  color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 18px; font-family: inherit;
}
.dss-input:disabled { opacity: .5; }
.dss-select { cursor: pointer; }
.dss-switch {
  margin-left: auto; position: relative; flex: none; cursor: pointer;
  width: 34px; height: 20px; padding: 0; border: none; border-radius: 10px;
  background: var(--dsw-alias-bg-tertiary, var(--dsw-alias-bg-secondary));
  transition: background .15s ease;
}
.dss-switch-on { background: var(--dsw-alias-brand-primary, #247bbf); }
.dss-switch:disabled { cursor: default; opacity: .5; }
.dss-switch-knob {
  position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
  border-radius: 50%; background: #fff; transition: transform .15s ease;
}
.dss-switch-on .dss-switch-knob { transform: translateX(14px); }
.dss-modes {
  display: inline-flex; margin-left: auto;
  border: 1px solid var(--dsw-alias-border-secondary); border-radius: 6px; overflow: hidden;
}
.dss-mode {
  border: none; cursor: pointer; padding: 4px 12px; background: transparent;
  color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; font-family: inherit;
}
.dss-mode + .dss-mode { border-left: 1px solid var(--dsw-alias-border-secondary); }
.dss-mode-on { background: var(--dsw-alias-bg-secondary); color: var(--dsw-alias-label-primary); font-weight: 500; }
.dss-mode:disabled { cursor: default; opacity: .5; }
.dss-footer { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding-top: 6px; border-top: 1px solid var(--dsw-alias-border-secondary); }
.dss-btn {
  padding: 4px 12px; cursor: pointer; font-family: inherit;
  border: 1px solid var(--dsw-alias-border-secondary); border-radius: 6px;
  background: var(--dsw-alias-bg-primary); color: var(--dsw-alias-label-primary);
  font-size: 12px; line-height: 18px;
}
.dss-btn-primary { background: var(--dsw-alias-brand-primary, #247bbf); border-color: transparent; color: #fff; }
.dss-btn:disabled { cursor: default; opacity: .5; }
`;

		/** 幂等注入样式标签。 */
		function injectStyles() {
			if (document.querySelector(`style[data-plugin-css="${STYLE_MARK}"]`) !== null) return;
			const style = document.createElement('style');
			style.setAttribute('data-plugin-css', STYLE_MARK);
			style.textContent = css;
			document.head.appendChild(style);
		}
		//#endregion

		/**
		 * 激活本插件的浏览器半边。
		 *
		 * ⚠️ **不要用 `ctx.configForms.whileServed([...])` 包住槽位注册**。
		 * 它只在"宿主设置镜像里出现该命名空间"时才执行注册，条件不成立就**永远不注册、
		 * 且不报任何错** —— 表现就是"插件页里什么都没有、控制台也没有报错"，极难定位。
		 * 对照参考：本机能正常出面板的 `dshmarket`，就是**无条件直接注册**的。
		 *
		 * @param ctx - 客户端运行时。
		 */
		function apply(ctx) {
			// 自诊断：所有失败都显式打日志，绝不静默（照 dshmarket 的容错写法）。
			const warn = (message) => {
				try { ctx.logger?.warn?.(`${PLUGIN_ID}: ${message}`); } catch { /* 日志失败无所谓 */ }
				try { console.warn(`[${PLUGIN_ID}] ${message}`); } catch { /* 忽略 */ }
			};

			injectStyles();
			ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), `${PLUGIN_ID}: dictionaries`);

			// 配置表单控制器（ConfigFormController）：getSnapshot / subscribe / mutate。
			let form;
			try {
				form = ctx.configForms.get(PLUGIN_ID);
			} catch (error) {
				warn(`取配置表单失败，面板不注册：${error?.message ?? error}`);
				return;
			}
			if (form === undefined || typeof form.getSnapshot !== 'function') {
				warn('配置表单缺少 getSnapshot，面板不注册');
				return;
			}

			const Card = createStageSpeakCard({
				mutate: (ops, revision) => form.mutate(ops, revision),
			});

			// hook 本体直接用表单控制器：渲染器把它交给 `bindSnapshotSelector`，
			// 而它要求的契约就是 `{ getSnapshot, subscribe }`，这两条控制器都有。
			// ⚠️ 选择器必须恒等：快照引用本身稳定，返回新对象会让 useSyncExternalStore
			//    反复判定"变了"而无限重渲染。
			try {
				ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
					name: 'plugins.bundle.config',
					key: PLUGIN_ID,
					locale: LOCALE_NS,
					inject: () => ({
						// ⚠️ 键名不带 `use`，宿主会加（见文件头规则 3）→ 组件拿到 props.useStageSpeakCard
						hooks: { StageSpeakCard: form },
						// 保存/放弃由面板自己调 mutate（一次提交多个字段），故这两个动作是空实现。
						save: () => {},
						discard: () => {},
					}),
				}, Card));
			} catch (error) {
				warn(`注册 plugins.bundle.config 槽位失败：${error?.message ?? error}`);
				return;
			}
			try { ctx.logger?.info?.(`${PLUGIN_ID}: 面板已注册到 plugins.bundle.config`); } catch { /* 忽略 */ }
		}

		exports.name = PLUGIN_NAME;
		exports.inject = ['slots', 'locale', 'configForms'];
		exports.apply = apply;
		return module.exports;
	},
});
