// activity.js — 每个会话的活动缓冲 + 阶段边界判定。
//
// 这一层是"什么时候该说话"的唯一决策点。它只读事件、只维护状态，
// 不碰网络、不碰子进程，因此可以完全离线单测。

/** 活动缓冲的条目上限，防止长会话把内存吃满。 */
export const MAX_ENTRIES = 40;

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
      if (
        cfg.stageToolCalls > 0
        && state.toolCallsSinceAnnounce >= cfg.stageToolCalls
      ) {
        return { reason: 'tool-milestone', priority: PRIORITY.low };
      }
      return null;
    }

    case 'tool/result': {
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
