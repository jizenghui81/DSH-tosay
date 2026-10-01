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
 * 把在飞调用写成人话，供心跳在"缓冲已被 drain 清空"时补齐快照。
 *
 * 为什么要它：心跳触发时缓冲常常是空的（上一次播报刚抽干），若直接送去摘要，
 * 模型只能拿到「（无具体操作，只有对话）」，说不出在等什么，只能给"还在处理中"这类废话。
 * 这里如实报**正在跑什么 + 等了多久**——只陈述事实，不编造进展。
 *
 * @param {object} state - 会话状态。
 * @param {number} [now] - 当前时间戳（测试注入用）。
 * @returns {string} 一句描述；没有在飞调用时返回空串。
 */
export function pendingWorkLine(state, now = Date.now()) {
  const calls = Array.isArray(state?.inFlightCalls) ? state.inFlightCalls : [];
  if (calls.length === 0) return '';
  const oldest = calls[0];
  const waited = Math.max(0, Math.round((now - (Number(oldest?.at) || now)) / 1000));
  const name = typeof oldest?.name === 'string' && oldest.name !== '' ? oldest.name : '某个操作';
  const hint = typeof oldest?.hint === 'string' ? oldest.hint : '';
  const what = hint === '' ? name : `${name}（${hint}）`;
  const more = calls.length > 1 ? `，另有 ${calls.length - 1} 个调用同时在跑` : '';
  return `仍在执行 ${what}，已等待 ${waited} 秒${more}`;
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
      const text = textOfMessage(event.data?.message);
      if (text !== '') push(state, 'assistant', clipAssistant(text));
      return null;
    }

    case 'tool/call': {
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
      const reason = typeof event.data?.reason === 'string' ? event.data.reason : '';
      const detail = reason.trim() === '' ? toolName : `${toolName}：${reason.trim()}`;
      push(state, 'approval', `需要审批 ${detail}`);
      return cfg.announceApprovals
        ? { reason: 'approval', priority: PRIORITY.high }
        : null;
    }

    case 'turn/end': {
      const kind = event.data?.reason?.kind ?? 'completed';
      push(state, 'turn', `轮次结束（${kind}）`);
      state.turnActive = false;
      // 轮次结束仍在飞的调用（被中断/超时）不该继续点亮心跳。
      state.inFlightCalls = [];
      state.pendingUserTask = '';
      state.kickoffDoneThisTurn = false;
      if (!cfg.announceTurnEnd) return null;
      // 光聊天没干活的一轮不值得念。
      // ⚠️ 必须用 turnToolCalls（轮次级，播报不清零），不能用 toolCallsSinceAnnounce ——
      //    后者会被中途的心跳清零，导致干了很多活的轮次反而不播收尾。
      if (state.turnToolCalls < Math.max(0, cfg.turnEndMinToolCalls)) return null;
      return { reason: 'turn-end', priority: PRIORITY.normal };
    }

    case 'goal/change': {
      if (!cfg.announceGoalChange) return null;
      const objective = typeof event.data?.change?.objective === 'string' ? event.data.change.objective : '';
      push(state, 'goal', objective === '' ? '目标有更新' : `目标：${objective.slice(0, 80)}`);
      return { reason: 'goal-change', priority: PRIORITY.normal };
    }

    default:
      return null;
  }
}

/**
 * 把缓冲抽干成一个给摘要模型看的活动清单。
 * @param {object} state - 该会话的状态。
 * @returns {{task: string, lines: string[], toolCalls: number}} 活动快照。
 */
export function drain(state) {
  const lines = state.entries.map((entry) => entry.text);
  const snapshot = {
    task: state.lastUserTask,
    lines,
    toolCalls: state.toolCallsSinceAnnounce,
  };
  state.entries = [];
  state.toolCallsSinceAnnounce = 0;
  return snapshot;
}
