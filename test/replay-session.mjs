// replay-session.mjs — 用真实 DSH 会话日志回放阶段边界判定。
//
// 用途：校准默认参数、验证事件形状假设、量化某个配置会播报多少次。
//
// 跑法：
//   node test/replay-session.mjs ~/.dsh/sessions/<工作区>/<会话>/session.v4.jsonl.zstd
//   node test/replay-session.mjs <日志> --stage-tool-calls 20 --ignore FS_NOT_OBSERVED
//
// 背景：会话日志是「每批追加一个独立 zstd 帧」拼接而成，Node 的
// zstdDecompressSync 只解第一帧，所以这里按帧魔数切分逐帧解。

import fs from 'node:fs';
import zlib from 'node:zlib';
import { createSessionState, noteEvent, drain } from '../lib/activity.js';

const FRAME_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/** 扫描所有 zstd 帧魔数的位置。 */
function magicPositions(buf) {
  const out = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === FRAME_MAGIC[0] && buf[i + 1] === FRAME_MAGIC[1]
      && buf[i + 2] === FRAME_MAGIC[2] && buf[i + 3] === FRAME_MAGIC[3]) out.push(i);
  }
  return out;
}

/**
 * 解压多帧 zstd 文件。边界不确定时逐步扩大切片范围重试。
 * @param {string} file - 日志路径。
 * @returns {{text: string, frameCount: number}}
 */
export function decompressAll(file) {
  const buf = fs.readFileSync(file);
  const positions = magicPositions(buf);
  const parts = [];
  let i = 0;
  let frameCount = 0;
  while (i < positions.length) {
    let advanced = false;
    for (let j = i + 1; j <= positions.length; j++) {
      const end = j < positions.length ? positions[j] : buf.length;
      try {
        parts.push(zlib.zstdDecompressSync(buf.subarray(positions[i], end)));
        frameCount += 1;
        i = j;
        advanced = true;
        break;
      } catch { /* 这个边界不对，继续扩大 */ }
    }
    if (!advanced) i += 1;
  }
  return { text: Buffer.concat(parts).toString('utf8'), frameCount };
}

/** 解析简单命令行参数。 */
function parseArgs(argv) {
  const out = { file: '', stageToolCalls: 12, ignore: ['FS_NOT_OBSERVED', 'FS_STALE_VERSION'], verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--stage-tool-calls') out.stageToolCalls = Number(argv[++i]);
    else if (arg === '--ignore') out.ignore = String(argv[++i]).split(',').filter(Boolean);
    else if (arg === '--verbose') out.verbose = true;
    else if (!arg.startsWith('--')) out.file = arg;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.file === '') {
  console.error('用法: node test/replay-session.mjs <session.v4.jsonl.zstd> [--stage-tool-calls N] [--ignore A,B] [--verbose]');
  process.exit(2);
}

const { text, frameCount } = decompressAll(args.file);
const lines = text.split('\n').filter((line) => line.trim() !== '');

const counts = new Map();
const events = [];
for (const line of lines) {
  let obj;
  try { obj = JSON.parse(line); } catch { continue; }
  if (obj?.type === 'session') continue;
  const event = obj?.event ?? obj;
  if (typeof event?.type !== 'string') continue;
  counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  events.push(event);
}

console.log(`解出 ${frameCount} 个 zstd 帧，${lines.length} 行，${events.length} 个事件`);
console.log('\n事件类型分布:');
[...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
  .forEach(([type, n]) => console.log(`  ${String(n).padStart(5)}  ${type}`));

const CFG = {
  stageToolCalls: args.stageToolCalls,
  announceTodoCompleted: true,
  announceTurnEnd: true,
  announceApprovals: true,
  announceGoalChange: false,
  turnEndMinToolCalls: 1,
  toolErrorIgnoreCodes: args.ignore,
  toolErrorPriority: 'normal',
};

const state = createSessionState('replay');
const boundaries = [];
for (const event of events) {
  const hit = noteEvent(state, event, CFG);
  if (hit === null) continue;
  const snapshot = drain(state);
  boundaries.push({ reason: hit.reason, code: hit.code, priority: hit.priority, toolCalls: snapshot.toolCalls, sample: snapshot.lines.slice(-2) });
}

const byReason = new Map();
let highCount = 0;
for (const b of boundaries) {
  byReason.set(b.reason, (byReason.get(b.reason) ?? 0) + 1);
  if (b.priority >= 3) highCount += 1;
}

console.log(`\n配置: stageToolCalls=${args.stageToolCalls} ignore=[${args.ignore.join(', ')}]`);
console.log(`判定出的阶段边界: ${boundaries.length} 个（其中打断级 ${highCount} 个）`);
for (const [reason, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${reason}`);
}

if (args.verbose) {
  console.log('\n边界明细:');
  boundaries.forEach((b, index) => {
    console.log(`  ${index + 1}. [${b.reason}${b.code === undefined || b.code === '' ? '' : ` ${b.code}`}] 步数=${b.toolCalls}`);
    b.sample.forEach((line) => console.log(`       · ${line.slice(0, 90)}`));
  });
}
