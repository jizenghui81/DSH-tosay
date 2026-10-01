// summarize.js — 摘要层：把活动清单压成一句能听的人话。
//
// 这是整个插件里"像不像真人"的关键。LLM 可用时走 LLM；不可用或失败时
// 退回规则摘要，保证永远不会因为摘要失败而沉默。

import { cleanForSpeech, truncateForSpeech } from './clean.js';

/** 播报员人设（阶段/结果播报用）。刻意约束成"一句话"，否则模型会写成汇报稿。 */
const SYSTEM_PROMPT = [
  '你是一个编程助手的语音播报员。你的听众正戴着耳机做别的事，只能用耳朵获取信息。',
  '把给你的工作记录压缩成 1 到 2 句中文口语。',
  '规则：',
  '1. 直接说发生了什么、结果如何、是否需要对方做决定；不要客套，不要"好的""那么"。',
  '2. 不要念文件路径、函数名、命令原文、版本号、markdown 符号；用人能听懂的说法。',
  '3. 不要用列表、编号、标题；就是一段连续的话。',
  '4. 总长控制在 60 个汉字以内。',
  '5. 只输出这句话本身，不要任何前缀、引号或解释。',
].join('\n');

/**
 * 开工反馈专用人设。
 * 与阶段播报的区别：这时什么都还没做，要说的是"收到 + 打算怎么下手"，不是"发生了什么"。
 */
const KICKOFF_PROMPT = [
  '你是编程助手的语音播报员。用户刚交代了一件事，助手正准备开工。',
  '你要替助手给出第一时间的口头反馈，像员工接了活当场回话那样。',
  '规则：',
  '1. 先用半句话确认收到——自然、干脆。禁止"好的！""没问题！""收到收到"这类填充和谄媚。',
  '2. 再用一句话说清打算怎么下手。**只讲思路方向**，绝对不要编造具体步骤、文件名、命令或数字。',
  '3. 不要念路径、命令、markdown；不要用列表。',
  '4. 总长控制在 45 个汉字以内。',
  '5. 只输出这段话本身，不要任何前缀、引号或解释。',
].join('\n');

/**
 * 静默心跳专用人设。
 * 用户看不到屏幕、已经有一阵子没听到反馈了，目的是"说清在做什么"，不是汇报结果。
 */
const HEARTBEAT_PROMPT = [
  '你是编程助手的语音播报员。助手正在干活，用户看不到屏幕，已经有一会儿没听到动静了。',
  '用一句话告诉他现在在做什么、进行到哪一步。',
  '规则：',
  '1. 说"正在做什么"，不要下结论、不要汇报结果（还没结束）。',
  '2. 不要念路径、命令、markdown；不要用列表。',
  '3. 不要说"请稍等""马上就好"这类套话。',
  '4. ⚠️ **只陈述记录里确实发生过的事**。禁止说"没有卡住""一切正常""快好了"——',
  '   你看不到内部状态，这类断言就是编造。要让人安心，靠说清"在做什么"，不靠下保证。',
  '5. 总长控制在 45 个汉字以内。',
  '6. 只输出这句话本身。',
].join('\n');

/**
 * 按边界类型挑语体。
 * @param {string} reason - 边界原因。
 * @returns {string} system prompt。
 */
export function systemPrompt(reason) {
  if (reason === 'kickoff') return KICKOFF_PROMPT;
  if (reason === 'progress-heartbeat') return HEARTBEAT_PROMPT;
  return SYSTEM_PROMPT;
}

/** 每个边界的补充要求。 */
const REASON_HINT = {
  'approval': '重点：助手停下了，在等你审批。说清要你批准什么、为什么。不要念命令原文、路径或 JSON。',
  'user-question': '重点：助手停下了，在等你回答一个问题。说清它问的是什么、为什么问。',
  'tool-error': '重点：刚才有操作失败了。说清失败在哪，以及是否影响继续。',
  'todo-completed': '重点：一个阶段刚完成。说清完成了什么，还剩多少。',
  'turn-end': '重点：这一轮工作结束了。用一句话总结这一轮做成了什么。⚠️ 如果助手的收尾消息里向用户提了问题、给了选项、或说了「要不要我做 X」，**必须把它转达出来**（这类内容通常在收尾消息的最末尾）。只有在确实没有任何待定事项时，才说「不需要你决定什么」。',
  'tool-milestone': '重点：工作还在进行中。说清进展到哪了。',
  'goal-change': '重点：目标有更新。说清新目标是什么。',
  'kickoff': '重点：用户刚交代任务，助手要开工。先确认收到，再说打算怎么下手（只讲思路，不编造步骤）。',
  'progress-heartbeat': '重点：工作还在进行中，用户看不到屏幕。说清正在做什么、到哪一步了，让他放心。',
};

/**
 * 规则摘要：LLM 不可用时的兜底。不漂亮，但一定说得出来。
 * @param {object} snapshot - drain() 的活动快照。
 * @param {string} reason - 边界原因。
 * @returns {string} 一句中文。
 */
export function ruleSummary(snapshot, reason) {
  const lines = Array.isArray(snapshot?.lines) ? snapshot.lines : [];
  const toolCalls = Number.isFinite(snapshot?.toolCalls) ? snapshot.toolCalls : 0;
  const errors = lines.filter((line) => line.startsWith('工具报错')).length;

  if (reason === 'approval') {
    const line = lines.find((item) => item.startsWith('需要审批'));
    return line === undefined ? '助手在等你批准一个操作。' : `助手在等你批准：${line.replace(/^需要审批\s*/, '')}。`;
  }
  if (reason === 'user-question') {
    return '助手在等你回答一个问题。';
  }
  if (reason === 'tool-error') {
    return `刚才有 ${Math.max(1, errors)} 个操作报错了，建议看一眼。`;
  }
  if (reason === 'todo-completed') {
    const last = [...lines].reverse().find((item) => item.startsWith('待办'));
    return last === undefined ? '一个阶段完成了。' : `阶段完成，${last.replace(/^待办\s*/, '')}。`;
  }
  if (reason === 'goal-change') {
    const line = [...lines].reverse().find((item) => item.startsWith('目标'));
    return line === undefined ? '目标有更新。' : `${line}。`;
  }
  if (reason === 'kickoff') {
    return '收到，我先看一下这个问题，理清思路再动手。';
  }
  if (reason === 'progress-heartbeat') {
    return toolCalls > 0 ? `还在处理中，已经走了 ${toolCalls} 步，没有卡住。` : '还在处理中，没有卡住。';
  }
  if (reason === 'turn-end') {
    // ⚠️ 必须用**轮次级**计数 `turnToolCalls`，不能用 `toolCalls`：
    //    后者是 drain() 抽干后的"距上次播报"量，一次心跳就清零，
    //    于是干了很多活的一轮会被规则摘要说成"没操作"；而零值分支吐出的
    //    「这一轮结束了。」又恰好等于 v1.3.0 的确定性收束语 → 拼出重复两遍。
    //    （实测 2026-10-01 06:53；与 V1.1.4 是同一类错误。）
    const steps = Number.isFinite(snapshot?.turnToolCalls) ? snapshot.turnToolCalls : toolCalls;
    return steps > 0
      ? `这一轮做完了，一共 ${steps} 步操作。`
      : '这一轮没有具体操作。';
  }
  return toolCalls > 0 ? `进行中，已经走了 ${toolCalls} 步。` : '还在继续处理。';
}

/**
 * 组装送给摘要模型的提示词。
 * @param {object} snapshot - drain() 的活动快照。
 * @param {string} reason - 边界原因。
 * @returns {string} 提示词。
 */
export function buildPrompt(snapshot, reason) {
  const lines = Array.isArray(snapshot?.lines) ? snapshot.lines : [];
  const parts = [];
  if (typeof snapshot?.task === 'string' && snapshot.task.trim() !== '') {
    const task = snapshot.task.replace(/\s+/g, ' ').trim();
    parts.push(`用户交代的任务：${task.length > 300 ? task.slice(0, 300) + '…' : task}`);
  }
  parts.push('本阶段的工作记录（按时间顺序）：');
  parts.push(lines.length === 0 ? '（无具体操作，只有对话）' : lines.map((line) => `- ${line}`).join('\n'));
  const hint = REASON_HINT[reason];
  if (hint !== undefined) parts.push(hint);
  return parts.join('\n');
}

/**
 * 调一次模型做摘要；任何失败都返回 null，由调用方走规则摘要。
 * @param {object} deps - {llm, provider, model, logger, signal}。
 * @param {object} snapshot - drain() 的活动快照。
 * @param {string} reason - 边界原因。
 * @returns {Promise<string|null>} 摘要文本，失败返回 null。
 */
export async function llmSummary(deps, snapshot, reason) {
  const { llm, provider, model, logger, signal } = deps;
  if (llm === undefined || llm === null) return null;
  if (typeof provider !== 'string' || provider === '') return null;
  if (typeof model !== 'string' || model === '') return null;

  const messages = [{
    role: 'user',
    content: [{ type: 'text', text: buildPrompt(snapshot, reason) }],
  }];

  let text = '';
  let failed = false;
  try {
    const stream = llm.stream({
      provider,
      model,
      system: systemPrompt(reason),
      messages,
      temperature: 0.3,
      maxTokens: 200,
      ...(signal === undefined ? {} : { signal }),
    });
    for await (const chunk of stream) {
      if (chunk === null || typeof chunk !== 'object') continue;
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text;
      } else if (chunk.type === 'finish') {
        const kind = chunk.reason?.kind;
        if (kind === 'error' || kind === 'aborted') failed = true;
      }
    }
  } catch (error) {
    if (logger !== undefined) logger.warn('dsh-stage-speak: 摘要调用失败 %s', String(error?.message ?? error));
    return null;
  }

  if (failed) return null;
  const cleaned = cleanForSpeech(text);
  return cleaned === '' ? null : cleaned;
}

/**
 * 完整的摘要流水线：LLM 优先，失败退规则；**并报出这一句是谁写的**。
 *
 * 为什么需要这个字段：2026-10-01 排查「同一句话连听两遍」时，日志里只有最终文本，
 * **无法判断走的是 LLM 还是规则兜底**，只能靠推理去猜 —— 白花一轮。
 * 现在把它写进 announce 行的第 4 个字段（`reason / text / source`），一眼可辨。
 *
 * @param {object} deps - {llm, provider, model, logger, signal, maxChars}。
 * @param {object} snapshot - drain() 的活动快照。
 * @param {string} reason - 边界原因。
 * @returns {Promise<{text: string, source: 'llm'|'rule'}>} 文本与来源。
 */
export async function summarizeDetailed(deps, snapshot, reason) {
  const viaModel = await llmSummary(deps, snapshot, reason);
  const raw = viaModel ?? ruleSummary(snapshot, reason);
  return {
    text: truncateForSpeech(cleanForSpeech(raw), deps.maxChars),
    source: viaModel === null ? 'rule' : 'llm',
  };
}

/**
 * 完整的摘要流水线：LLM 优先，失败退规则。
 * @param {object} deps - {llm, provider, model, logger, signal}。
 * @param {object} snapshot - drain() 的活动快照。
 * @param {string} reason - 边界原因。
 * @returns {Promise<string>} 可直接朗读的一句话。
 */
export async function summarize(deps, snapshot, reason) {
  return (await summarizeDetailed(deps, snapshot, reason)).text;
}
