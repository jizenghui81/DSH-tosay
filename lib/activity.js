// activity.js — 每个会话的活动缓冲 + 阶段边界判定。
//
// 这一层是"什么时候该说话"的唯一决策点。它只读事件、只维护状态，
// 不碰网络、不碰子进程，因此可以完全离线单测。

/** 活动缓冲的条目上限，防止长会话把内存吃满。 */
export const MAX_ENTRIES = 40;

/** 在飞调用记录的上限，防止病态会话无限增长。 */
export const MAX_IN_FLIGHT = 16;

/**
 * 助手消息进活动缓冲时保留「头 + 尾」的字符数。
 *
 * ⚠️ 2026-10-01 实测（243 个有收尾消息的轮次）：助手收尾消息长度**中位数 1615 字**，
 * 93% 超过 160 字。而写作者的习惯是**开头讲结论、末尾才提问题/给选项** ——
 * 只留前 160 字会把 **91% 的「需要你决定」信号切掉**（79 个含该信号的轮次里，
 * 只有 7 个的信号落在前 160 字内）。摘要模型看不到问题，就只会说"不需要你决定什么"。
 * 所以头尾都要留。
 */
export const ASSISTANT_HEAD = 100;
export const ASSISTANT_TAIL = 200;

/** 头 + 尾保留：结论在开头，待决事项在末尾，中段过程信息可丢。 */
function clipAssistant(text) {
  if (text.length <= ASSISTANT_HEAD + ASSISTANT_TAIL) return text;
  return `${text.slice(0, ASSISTANT_HEAD)}……（中略）……${text.slice(-ASSISTANT_TAIL)}`;
}

/** 边界优先级：high 会打断正在播报的内容，low 会在忙时被合并丢弃。 */
export const PRIORITY = { high: 3, normal: 2, low: 1 };

/**
 * turn-end 的收束语 —— **由代码写死，绝不经过摘要模型**。
 *
 * ⚠️ 为什么必须确定性（2026-10-01 用户实测反馈：「任务全做完之后，我可能听不出来这是一个
 *    明确的会话结束信号」）：审计 30 条 turn-end 播报，只有 4 条带收尾措辞，且措辞各不相同
 *    （"这轮任务完成" / "这轮结束了" / "这一轮做完了"），而同期 156 条**中途**进展播报里
 *    也有 10 条含同类词汇 —— 两边词汇重叠，耳朵没有任何可依赖的判别特征。
 *    把结束信号交给 LLM 生成，等于把它变成一个随机事件。
 *
 * ⚠️ 放**句首**而非句尾是结构性要求：`truncateForSpeech`（clean.js）只保留**前缀窗口**
 *    （`text.slice(0, maxChars)` 再回退到最后一个句末），句尾内容超长会被整段截掉。
 *    收束语放句尾，摘要一长就没影了。
 */
export const TURN_END_CLOSER = {
  completed: '这一轮结束了。',
  error: '这一轮报错中断了。',
  aborted: '这一轮被中断了。',
};

/**
 * 取某个结束原因对应的收束语。
 * @param {unknown} kind - `turn/end` 的 `reason.kind`（实测分布：completed 224 / error 15 / aborted 2）。
 * @returns {string} 收束语；未知 kind 回退到"正常结束"。
 */
export function closerFor(kind) {
  return typeof kind === 'string' && Object.prototype.hasOwnProperty.call(TURN_END_CLOSER, kind)
    ? TURN_END_CLOSER[kind]
    : TURN_END_CLOSER.completed;
}

/**
 * **断点信号**：需要用户动手时，必须有一句确定性的话把"这是个断点"说出来。
 *
 * ⚠️ 与收束语同源的问题（2026-10-01 用户反馈）：「你没有明确听到说这是一个需要我去审批或确认的
 *    断点」—— 审批事件带的信息是 `toolName`（英文）+ `reason`（中文长句，内含原始命令与 JSON），
 *    交给模型概括就容易被写成"正在进行中"的语气。所以断点信号由代码写死，模型只负责说清"要批什么"。
 */
export const APPROVAL_SIGNAL = '这一轮停下了，需要你审批。';
export const ASK_USER_SIGNAL = '这一轮停下了，需要你回答一个问题。';

/**
 * 取消息里的可见文本（只取 text 块，忽略 reasoning / tool-call）。
 * @param {unknown} message - 会话消息对象。
 * @returns {string} 拼起来的纯文本。
 */
/**
 * 判断一条 user/message 是否**真正的用户输入**。
 *
 * ⚠️ 实测（2026-10-01，58 个会话 / 303 条 user/message）：`user/message` 里混着
 * 大量系统注入，真用户输入只占约一半：
 *   user 156 ｜ agent-instructions 44（**31KB 的 AGENTS.md**）｜ runtime-context 32
 *   ｜ skill-catalog 22（**29KB 技能目录**）｜ tool-jobs 19 ｜ agent-message 8
 *   ｜ subagent-settled 8 ｜ compact-checkpoint 5 ｜ goal 4 ｜ user-approval 3 ｜ tool-goal 2
 * 不过滤就会把 30KB 注入当成"用户交代的任务"，摘要直接跑偏。
 * source 缺失时放行（兼容旧日志/其它宿主），有 source 则必须是 kind === 'user'。
 */
export function isRealUserMessage(message) {
  if (message === null || typeof message !== 'object') return false;
  const source = message.source;
  if (source === undefined || source === null) return true;
  return source.kind === 'user';
}

export function textOfMessage(message) {
  const content = message && typeof message === 'object' ? message.content : undefined;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}

/** 从工具入参 JSON 里取一个短提示，用于让摘要知道"在动哪个文件/跑什么命令"。 */
export function toolHint(rawArguments) {
  if (typeof rawArguments !== 'string' || rawArguments.length === 0) return '';
  let parsed;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    return '';
  }
  if (parsed === null || typeof parsed !== 'object') return '';
  for (const key of ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'prompt', 'description']) {
    const value = parsed[key];
    if (typeof value === 'string' && value.trim() !== '') {
      const flat = value.replace(/\s+/g, ' ').trim();
      return flat.length > 60 ? flat.slice(0, 60) + '…' : flat;
    }
  }
  return '';
}

/**
 * 归一待办列表，容错任何形状。
 * @param {unknown} value - `todo/write` 的 data.todos。
 * @returns {{total: number, completed: number, inProgress: number, items: Array<{content: string, status: string}>}}
 */
export function readTodos(value) {
  const items = Array.isArray(value)
    ? value
      .filter((item) => item && typeof item === 'object' && typeof item.content === 'string')
      .map((item) => ({
        content: item.content.replace(/\s+/g, ' ').trim(),
        status: typeof item.status === 'string' ? item.status : 'pending',
      }))
    : [];
  return {
    total: items.length,
    completed: items.filter((item) => item.status === 'completed').length,
    inProgress: items.filter((item) => item.status === 'in_progress').length,
    items,
  };
}

/**
 * 建一个会话的播报状态。
 * @param {string} sessionId - 会话 id。
 * @returns {object} 可变状态对象（由插件持有）。
 */
export function createSessionState(sessionId) {
  return {
    id: sessionId,
    entries: [],
    /**
     * 本会话的**音色覆盖**（方案 A：音色绑定会话）。空串 = 主音色，由 index.js 在
     * 会话首次出现时分配；engine 只认非空值，留空即完全不影响既有音色链路。
     */
    voiceOverride: '',
    toolCallsSinceAnnounce: 0,
    completedTodos: 0,
    lastUserTask: '',
    /** 本轮之前那条用户消息；turn/end 时清空。用于「开工反馈」的新消息守卫。 */
    pendingUserTask: '',
    /** 本轮是否仍在进行 —— 静默心跳只在本轮进行中才可能触发。 */
    turnActive: false,
    turnStartedAt: 0,
    /** 本轮是否已经播过开工反馈（一轮只播一次，用户中途插话不重复）。 */
    kickoffDoneThisTurn: false,
    /**
     * 本轮累计的工具调用次数 —— **只在 turn/start 清零**，播报不清零。
     *
     * ⚠️ 不要用 toolCallsSinceAnnounce 判断"这一轮有没有干活"：drain() 每次播报都会把它清零，
     * 于是「心跳刚播完 → 几秒后轮次结束」这种常见时序下，turn/end 会误判为"没干活"而**静默不播**。
     * 实测 2026-10-01 04:48：该轮干了 21 步，仅因心跳早 3 秒，整轮收尾播报被丢弃 ——
     * 而收尾播报恰恰承载着"要不要我做 X"这类待决事项。
     */
    turnToolCalls: 0,
    /**
     * "在干活但没有任何会话事件"的状态：`'model'`（等模型返回）或 `'compaction'`（压缩上下文）。
     *
     * ⚠️ 为什么要与缓冲解耦（同 inFlightCalls 的道理）：这类状态**在飞行期间零事件** ——
     * 没有 assistant/message（还没生成完）、没有 tool/call。而心跳的"有活动才报"守卫只看
     * drain() 之后的缓冲，于是整段生成期都是静默。
     * 实测（重放 33 个真实会话 / 393 段 >60s 静默）：这类静默 **44 段 / 5,258 秒**，
     * 中位 92 秒、最长 323 秒；而"完全无任何状态可报"的真空段是 **0 段**。
     * @type {''|'model'|'compaction'}
     */
    waitingKind: '',
    /** 进入上述状态的时刻（0 = 不在该状态）。 */
    waitingSince: 0,
    /**
     * 上一次"等模型"类心跳播报的时刻。
     *
     * 用途（节奏方案「丁」）：等模型时的话术高度雷同（只差秒数），所以续报有 60 秒下限；
     * 工具在飞、或有真实缓冲内容时不受此限。**不新增用户可见的旋钮**。
     */
    lastWaitingAnnounceAt: 0,
    /**
     * 有未决的审批。等待期间**抑制心跳**：球在用户手上，把"在等你批准"念成"在干活"是错的。
     * 实测 17 次 `approval/asked` **全部**发生在有工具在飞的时候，所以只靠 inFlightCalls 判断
     * 会让整段审批等待都被报成"还在跑一条命令"。
     */
    approvalPending: false,
    /**
     * 正在飞的工具调用：已收到 tool/call、还没等到 tool/result。
     *
     * ⚠️ 为什么必须与活动缓冲解耦（2026-10-01 实测根因）：
     * `bash {"command":"sleep 180"}` 这类**阻塞型调用**在飞行期间不产生任何会话事件 ——
     * 没有 tool/result（还没返回），也没有 assistant/message（模型没在生成）。
     * 而心跳的「有活动才报」守卫只看 drain() 之后的缓冲与 `toolCallsSinceAnnounce`，
     * 于是前一次播报的 drain() 一旦把这条 tool/call 从缓冲里消费掉，整个飞行期就
     * 再无"活动"，心跳被自己的守卫**整段压掉**。
     * 实测：便携投影仪选型会话静默 **187 秒**（14:28:25→14:31:33），期间 10 个心跳 tick
     * 全部倒在同一条 continue 上；而任务其实在推进（子代理回信到达过两次）。
     * 结论：在飞调用是**最确定的活动**，必须独立记录、**不随 drain() 清零**。
     * @type {Array<{callId: string, name: string, hint: string, at: number}>}
     */
    inFlightCalls: [],
    lastAnnounceAt: 0,
    inFlight: false,
    timer: null,
    disposed: false,
  };
}

/** 追加一条活动记录，超出上限时丢最旧的。 */
function push(state, kind, text) {
  if (typeof text !== 'string' || text.trim() === '') return;
  state.entries.push({ kind, text: text.trim() });
  if (state.entries.length > MAX_ENTRIES) {
    state.entries.splice(0, state.entries.length - MAX_ENTRIES);
  }
}

/**
 * 从 tool/result 的事件数据里取 callId。
 * 宿主版本不同，位置有两处：顶层 `toolCallId` 与 `message.source.callId`（实测两者都在）。
 * @param {any} data - `tool/result` 的 data。
 * @returns {string} callId，拿不到返回空串。
 */
function callIdOfResult(data) {
  if (typeof data?.toolCallId === 'string') return data.toolCallId;
  const nested = data?.message?.source?.callId;
  return typeof nested === 'string' ? nested : '';
}

/** 销掉一个在飞调用：按 callId 精确配对；拿不到 callId 时按 FIFO 兜底。 */
function settleInFlight(state, data) {
  const calls = state.inFlightCalls;
  if (!Array.isArray(calls) || calls.length === 0) return;
  const callId = callIdOfResult(data);
  const index = callId === '' ? 0 : calls.findIndex((entry) => entry.callId === callId);
  calls.splice(index >= 0 ? index : 0, 1);
}

/**
 * 把毫秒写成人话时长：`30 秒` / `2 分 10 秒` / `2 分钟` / `5 分 23 秒`。
 *
 * 为什么不能直接用秒：等模型三五分钟时会念出「已等待 184 秒」——听的人要自己换算，
 * 而这类播报的全部价值就是"让人不用费脑子"。
 * @param {unknown} ms - 毫秒数。
 * @returns {string} 口语时长。
 */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`;
}

/**
 * 工具名 → 人话状态短语。
 *
 * ⚠️ 为什么必须有这张表（2026-10-01 用户反馈）：「你相当于是直接把原始指令读了出来，
 *    中文又夹杂着，感觉很奇怪。」实测原样念出的是
 *    「仍在执行 bash（BEFORE=$(wc -l < ~/.dsh/dsh-stage-speak.log); echo "开始 UTC $…）」
 *    —— 中文里夹一段 shell，既难听也没信息量；`ask_user_question` 这类还会把英文工具名念出来。
 *
 * 分类依据是**真实频次**（33 个会话里单次 >30 秒、即真正会进事实播报的那些调用）：
 * bash 200 · run_code 42 · ask_user_question 32 · job_output 27 · plugin_manager 3 ·
 * write/edit 3 · sync_push/sync_pull 2 · web_fetch 1。
 */
const TOOL_PHRASES = {
  bash: '还在跑一条命令',
  run_code: '还在跑一段脚本',
  job_output: '还在等后台任务',
  job_list: '还在等后台任务',
  plugin_manager: '还在装或查插件',
  write: '还在写文件',
  edit: '还在改文件',
  read: '还在看文件',
  read_image: '还在看图片',
  grep: '还在查文件内容',
  glob: '还在找文件',
  web_search: '还在查资料',
  web_fetch: '还在读网页',
  subagent: '还在等子代理返回',
  send_message: '还在发消息',
  sync_push: '还在同步',
  sync_pull: '还在同步',
  present: '还在整理交付物',
  skill: '还在读技能说明',
  ask_user_question: '还在等你回答',
};

/** 未收录的工具一律用这句兜底 —— **绝不回落到英文工具名**。 */
const TOOL_PHRASE_FALLBACK = '还在跑一个操作';

/**
 * 把工具名翻译成中文状态短语（不含任何原始参数）。
 * @param {unknown} name - 工具名。
 * @returns {string} 状态短语。
 */
export function describeTool(name) {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(TOOL_PHRASES, name)
    ? TOOL_PHRASES[name]
    : TOOL_PHRASE_FALLBACK;
}

/**
 * 把在飞调用写成人话，供心跳在"缓冲已被 drain 清空"时补齐快照。
 *
 * 为什么要它：心跳触发时缓冲常常是空的（上一次播报刚抽干），若直接送去摘要，
 * 模型只能拿到「（无具体操作，只有对话）」，说不出在等什么，只能给"还在处理中"这类废话。
 * 这里如实报**在做什么 + 等了多久**——只陈述状态，**不念原始参数、不念工具名**。
 *
 * @param {object} state - 会话状态。
 * @param {number} [now] - 当前时间戳（测试注入用）。
 * @returns {string} 一句描述；没有在飞调用时返回空串。
 */
export function pendingWorkLine(state, now = Date.now()) {
  const calls = Array.isArray(state?.inFlightCalls) ? state.inFlightCalls : [];
  if (calls.length === 0) return '';
  const oldest = calls[0];
  const waited = Math.max(0, Number(now) - (Number(oldest?.at) || Number(now)));
  const more = calls.length > 1 ? `，另有 ${calls.length - 1} 个操作在跑` : '';
  return `${describeTool(oldest?.name)}，已经 ${formatDuration(waited)}${more}`;
}

/**
 * 清洗审批原因：剥掉 `escalate sandbox to danger-full-access: ` 这类**纯英文前缀**，
 * 只留后面的中文说明，免得模型照着英文写播报。
 * @param {unknown} reason - `approval/asked` 的 reason。
 * @param {number} [maxChars] - 截断长度。
 * @returns {string} 清洗后的原因文本。
 */
export function cleanApprovalReason(reason, maxChars = 160) {
  const raw = typeof reason === 'string' ? reason.trim() : '';
  if (raw === '') return '';
  const match = /[:：]\s/.exec(raw);
  let out = raw;
  if (match !== null && match.index > 0) {
    const head = raw.slice(0, match.index);
    // 前缀里没有汉字 → 判定为机器前缀（sandbox 升级说明等），丢掉
    if (!/[\u4e00-\u9fff]/.test(head)) out = raw.slice(match.index + match[0].length).trim();
  }
  return out.length > maxChars ? `${out.slice(0, maxChars)}…` : out;
}

/**
 * 进入"在干活但没有任何会话事件"的状态。
 *
 * ⚠️ 为什么需要它（2026-10-01 重放 33 个真实会话得出）：
 * 有一类静默**不是**工具在飞，而是主机正在等模型返回 —— 官方事件 `step/start` 的定义就是
 * 「a step = 一次模型调用 + 它请求的工具执行」，所以 `step/start` 之后、`assistant/message`
 * 之前，主机确定处于一次模型调用之中。实测这类静默 **44 段 / 5,258 秒**（中位 92 秒、最长 323 秒），
 * 全部落在心跳的空白里。
 *
 * @param {object} state - 会话状态。
 * @param {'model'|'compaction'} kind - 在等什么。
 * @param {number} [now] - 当前时间戳（测试注入用）。
 */
export function enterWaiting(state, kind, now = Date.now()) {
  if (state.waitingKind !== kind) {
    state.waitingKind = kind;
    state.waitingSince = now;
  } else if (!(Number(state.waitingSince) > 0)) {
    state.waitingSince = now;
  }
}

/** 离开"等模型 / 压缩上下文"状态。 */
export function leaveWaiting(state) {
  state.waitingKind = '';
  state.waitingSince = 0;
}

/**
 * 把"在等什么"写成人话（确定性模板，不经过摘要模型）。
 *
 * ⚠️ 只陈述**能证实的事实**：主机正在一次模型调用里、已经过了多久。
 * 不说"快好了"、不说"没有卡住"——那两句话在"请求已经发出去但还没回来"时是无法证实的。
 * @param {object} state - 会话状态。
 * @param {number} [now] - 当前时间戳（测试注入用）。
 * @returns {string} 一句描述；不在等待状态时返回空串。
 */
export function waitingLine(state, now = Date.now()) {
  const kind = state?.waitingKind;
  const since = Number(state?.waitingSince) || 0;
  if (kind === '' || kind === undefined || since <= 0) return '';
  const waited = Math.max(0, Number(now) - since);
  return kind === 'compaction'
    ? `正在压缩上下文，已经 ${formatDuration(waited)}。`
    : `还在等模型返回，已经 ${formatDuration(waited)}。`;
}

/**
 * 记录一个事件，并判断它是否构成一个"阶段边界"。
 * @param {object} state - 该会话的状态。
 * @param {{type: string, data: any}} event - 会话事件。
 * @param {object} cfg - 已解析配置。
 * @returns {null|{reason: string, priority: number}} 边界描述，或 null。
 */
export function noteEvent(state, event, cfg) {
  switch (event.type) {
    case 'user/message': {
      // 系统注入（AGENTS.md / 技能目录 / 运行时上下文…）一律不当用户任务
      if (!isRealUserMessage(event.data)) return null;
      const text = textOfMessage(event.data);
      if (text === '') return null;
      state.lastUserTask = text;
      state.pendingUserTask = text;

      // ⚠️ 实测事件顺序是 turn/start(seq 5) → user/message(seq 9)，
      //    所以开工反馈**必须在这里触发**，不能等 turn/start —— 那时消息还没到。
      if (!cfg.announceKickoff || state.kickoffDoneThisTurn) return null;
      if (text.trim().length < (cfg.kickoffMinTaskChars ?? 4)) return null;
      state.kickoffDoneThisTurn = true;
      state.turnActive = true;
      if (state.turnStartedAt === 0) state.turnStartedAt = Date.now();
      return {
        reason: 'kickoff',
        priority: PRIORITY.normal,
        throttleMs: cfg.kickoffThrottleMs,
      };
    }

    case 'turn/start': {
      // 与官方 todos 投影同构：每轮开头重置完成计数基线。
      state.completedTodos = 0;
      state.toolCallsSinceAnnounce = 0;
      state.turnToolCalls = 0;
      // 上一轮若被中断，可能留下永远等不到 result 的在飞调用 → 连带清掉，
      // 否则新的一轮会因为"有活在跑"而报出并不存在的进展。
      state.inFlightCalls = [];
      leaveWaiting(state);
      state.approvalPending = false;
      state.turnActive = true;
      state.turnStartedAt = Date.now();

      state.kickoffDoneThisTurn = false;

      // 兜底：若某个宿主把 user/message 排在 turn/start 之前，这里也要能开工。
      // 真实顺序下 pendingUserTask 此时是空的，走上面的 user/message 分支。
      if (!cfg.announceKickoff || state.kickoffDoneThisTurn) return null;
      const task = state.pendingUserTask.trim();
      if (task.length < (cfg.kickoffMinTaskChars ?? 4)) return null;
      state.kickoffDoneThisTurn = true;
      return {
        reason: 'kickoff',
        priority: PRIORITY.normal,
        // 开工反馈必须"第一时间"，用专用短窗口而不是默认的长防抖
        throttleMs: cfg.kickoffThrottleMs,
      };
    }

    case 'assistant/message': {
      // 模型生成结束 —— 无论内容长短，都不再是"等模型返回"状态。
      leaveWaiting(state);
      const text = textOfMessage(event.data?.message);
      if (text !== '') push(state, 'assistant', clipAssistant(text));
      return null;
    }

    case 'tool/call': {
      // 模型已经产出工具调用 → 生成阶段结束
      leaveWaiting(state);
      // 健壮性：插件可能在某一轮进行到一半时才挂载（重启/热重载），
      // 那样就永远看不到该轮的 turn/start → 误判"没有轮次在跑" → 心跳永不触发。
      // 只要还有工具调用在流，就说明这一轮确实在进行。
      if (!state.turnActive) {
        state.turnActive = true;
        if (state.turnStartedAt === 0) state.turnStartedAt = Date.now();
      }
      state.toolCallsSinceAnnounce += 1;
      state.turnToolCalls += 1;
      const name = typeof event.data?.name === 'string' ? event.data.name : '未知工具';
      const hint = toolHint(event.data?.arguments);
      push(state, 'tool', hint === '' ? name : `${name}(${hint})`);
      // 记在飞调用：**不随 drain() 清零**，供心跳判断"确实有活在跑"。
      const callId = typeof event.data?.callId === 'string' ? event.data.callId : '';
      state.inFlightCalls.push({ callId, name, hint, at: Date.now() });
      if (state.inFlightCalls.length > MAX_IN_FLIGHT) state.inFlightCalls.shift();
      // 「问用户一个问题」是一个**断点**，不是中间过程：必须明确说出来。
      // 实测 43 次、中位 49 秒、最长 540 秒（合计 1.2 小时）都卡在这里等用户。
      if (name === 'ask_user_question') {
        return { reason: 'user-question', priority: PRIORITY.high, signal: ASK_USER_SIGNAL };
      }
      if (
        cfg.stageToolCalls > 0
        && state.toolCallsSinceAnnounce >= cfg.stageToolCalls
      ) {
        return { reason: 'tool-milestone', priority: PRIORITY.low };
      }
      return null;
    }

    case 'tool/result': {
      // 无论成功还是失败，都要把对应的在飞调用销掉。
      // 漏销的后果不是"少报"而是"多报"：计数只增不减 → 心跳永远认为有活在跑，
      // 真卡住时也不再沉默 —— 正是这条守卫本来要防的反面。
      settleInFlight(state, event.data);

      const structured = event.data?.error;
      const isError = structured !== undefined || event.data?.message?.isError === true;
      if (!isError) return null;

      // 真实数据校准（回放 34 轮真实会话得到）：绝大多数工具报错是 FsError，
      // 且是「按设计可自愈」的观察策略错（先读后写、版本过期重放）。
      // 把它们当急事打断播报，体验会非常吵。按错误码过滤。
      const code = typeof structured?.code === 'string' ? structured.code : '';
      const ignore = Array.isArray(cfg.toolErrorIgnoreCodes) ? cfg.toolErrorIgnoreCodes : [];
      if (code !== '' && ignore.includes(code)) {
        push(state, 'error', `工具报错（${code}，按设计可自愈，不播报）`);
        return null;
      }

      push(state, 'error', code === '' ? '工具报错' : `工具报错（${code}）`);
      return {
        reason: 'tool-error',
        priority: cfg.toolErrorPriority === 'high' ? PRIORITY.high : PRIORITY.normal,
        code,
      };
    }

    case 'todo/write': {
      const todos = readTodos(event.data?.todos);
      push(state, 'todo', `待办 ${todos.completed}/${todos.total} 完成`);
      const advanced = todos.completed > state.completedTodos;
      state.completedTodos = todos.completed;
      if (advanced && cfg.announceTodoCompleted) {
        return { reason: 'todo-completed', priority: PRIORITY.normal };
      }
      return null;
    }

    case 'approval/asked': {
      const toolName = typeof event.data?.toolName === 'string' ? event.data.toolName : '某个操作';
      const cleaned = cleanApprovalReason(event.data?.reason);
      const detail = cleaned === '' ? toolName : `${toolName}：${cleaned}`;
      // 落进缓冲的是给模型看的材料（剥掉英文机器前缀）；**用户听到的断点信号**由 signal 保证。
      push(state, 'approval', `需要审批 ${detail}`);
      // 等待期间球在用户手上：抑制心跳，别把"在等你"念成"在干活"。
      state.approvalPending = true;
      return cfg.announceApprovals
        ? { reason: 'approval', priority: PRIORITY.high, signal: APPROVAL_SIGNAL }
        : null;
    }

    case 'approval/decided': {
      state.approvalPending = false;
      return null;
    }

    case 'turn/end': {
      const kind = event.data?.reason?.kind ?? 'completed';
      push(state, 'turn', `轮次结束（${kind}）`);
      state.turnActive = false;
      // 轮次结束仍在飞的调用（被中断/超时）不该继续点亮心跳。
      state.inFlightCalls = [];
      leaveWaiting(state);
      state.approvalPending = false;
      state.pendingUserTask = '';
      state.kickoffDoneThisTurn = false;
      if (!cfg.announceTurnEnd) return null;
      const closer = closerFor(kind);
      // 光聊天没干活的一轮不值得念**摘要**（没有可汇报的操作）。
      // ⚠️ 必须用 turnToolCalls（轮次级，播报不清零），不能用 toolCallsSinceAnnounce ——
      //    后者会被中途的心跳清零，导致干了很多活的轮次反而不播收尾。
      // ⚠️ 但**结束信号不能省**：这一轮同样结束了，用户同样需要知道。
      //    旧行为是整轮静默 → 那些轮次用户永远等不到结束信号（2026-10-01 用户反馈）。
      if (state.turnToolCalls < Math.max(0, cfg.turnEndMinToolCalls)) {
        if (!cfg.announceTurnEndOnChat) return null;
        return { reason: 'turn-end', priority: PRIORITY.normal, signal: closer, signalOnly: true };
      }
      return { reason: 'turn-end', priority: PRIORITY.normal, signal: closer };
    }

    case 'goal/change': {
      if (!cfg.announceGoalChange) return null;
      const objective = typeof event.data?.change?.objective === 'string' ? event.data.change.objective : '';
      push(state, 'goal', objective === '' ? '目标有更新' : `目标：${objective.slice(0, 80)}`);
      return { reason: 'goal-change', priority: PRIORITY.normal };
    }

    // ── "在干活但零事件"的两类状态 ─────────────────────────────────────────
    case 'step/start': {
      // 官方定义：`step/start` 打开一个 step = **一次模型调用 + 它请求的工具执行**。
      // 所以从这里到 `assistant/message` 之间，主机确定处在一次模型调用之中。
      // 这一整段不会产生任何会话事件 —— 正是"长生成期间听不到动静"的来源。
      if (!state.turnActive) {
        state.turnActive = true;
        if (state.turnStartedAt === 0) state.turnStartedAt = Date.now();
      }
      enterWaiting(state, 'model');
      return null;
    }

    case 'step/end':
    case 'assistant/attempt': {
      leaveWaiting(state);
      return null;
    }

    case 'llm/retry-started': {
      // 模型请求重试 —— 仍然是"在等模型返回"，重新计时
      enterWaiting(state, 'model');
      return null;
    }

    case 'compaction/start': {
      // 上下文压缩期间同样零事件。实测时序：compaction/start → summary → end → step/start，
      // 所以 end 清位之后紧跟的 step/start 会重新进入"等模型"，不会留下空白。
      enterWaiting(state, 'compaction');
      return null;
    }

    case 'compaction/end': {
      leaveWaiting(state);
      return null;
    }

    default:
      return null;
  }
}

/**
 * 把缓冲抽干成一个给摘要模型看的活动清单。
 * @param {object} state - 该会话的状态。
 * @returns {{task: string, lines: string[], toolCalls: number, turnToolCalls: number}} 活动快照。
 */
export function drain(state) {
  const lines = state.entries.map((entry) => entry.text);
  const snapshot = {
    task: state.lastUserTask,
    lines,
    toolCalls: state.toolCallsSinceAnnounce,
    /**
     * 轮次级累计（**播报不清零**）。
     *
     * ⚠️ 规则摘要判"这一轮干了多少活"必须用它，不能用 `toolCalls`：
     *    后者被每一次 drain() 清零 —— 一次心跳就能把整轮的活算成 0。
     *    实测后果（2026-10-01 06:53）：一轮明明干了 30 步，收尾的规则兜底却因为
     *    计数被心跳清零而吐出「这一轮结束了。」，与 v1.3.0 的确定性收束语拼成
     *    **「这一轮结束了。这一轮结束了。」**，用户连听两遍同一句。
     *    这与 V1.1.4 修过的 turn-end 守卫是同一类错误，只是漏在规则摘要这一层。
     */
    turnToolCalls: state.turnToolCalls,
  };
  state.entries = [];
  state.toolCallsSinceAnnounce = 0;
  return snapshot;
}
