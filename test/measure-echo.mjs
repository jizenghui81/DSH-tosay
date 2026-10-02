// measure-echo.mjs —— 用内核做一次干净的回声对照测量
//
// 假设：若 AEC 有效，麦克风电平在"播报中"与"播报前静音"应当接近。
// 若播报中明显抬升，说明回声串进来了（要么 AEC 没生效，要么音量过大）。
//
// 用法：node test/measure-echo.mjs [--vp-off] [音频文件]

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = join(HERE, '..', 'engine', 'audio-core');
const audio = process.argv.find((a) => a.endsWith('.mp3'))
  ?? join(homedir(), '.cache', 'dsh-stage-speak', '352f7d1fd72ee13ffa4687fabcedeb7c.mp3');
const vpOff = process.argv.includes('--vp-off');

const child = spawn(CORE, [], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ...(vpOff ? { VP_OFF: '1' } : {}) },
});

const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 每个相位收集若干采样：{ phase, level, playing }
const samples = [];
let currentPhase = 'startup';
let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    const text = line.trim();
    if (text === '') continue;
    try {
      const event = JSON.parse(text);
      if (event.ev === 'heartbeat') {
        samples.push({ phase: currentPhase, level: event.lastLevelDb, floor: event.noiseFloorDb, playing: event.playing, speaking: event.speaking });
      }
    } catch { /* 忽略非 JSON */ }
  }
});
child.stderr.on('data', (d) => process.stderr.write(`[core] ${d}`));

const average = (values) => (values.length === 0 ? NaN : values.reduce((a, b) => a + b, 0) / values.length);
const summarize = (phase) => {
  const rows = samples.filter((s) => s.phase === phase && Number.isFinite(s.level));
  return { n: rows.length, level: average(rows.map((s) => s.level)), floor: average(rows.map((s) => s.floor)) };
};

const run = async () => {
  // 等待校准完成
  await sleep(4000);

  for (let round = 1; round <= 2; round += 1) {
    currentPhase = `silence-${round}-before`;
    await sleep(5000);

    currentPhase = `playing-${round}`;
    send({ cmd: 'play', path: audio, id: `echo-${round}` });
    await sleep(11000);

    currentPhase = `silence-${round}-after`;
    await sleep(5000);
  }

  send({ cmd: 'quit' });
  await new Promise((resolve) => child.on('close', resolve));

  console.log(`\n=== 回声对照结果（AEC ${vpOff ? '关闭' : '开启'}）===`);
  const rows = [];
  for (let round = 1; round <= 2; round += 1) {
    const before = summarize(`silence-${round}-before`);
    const during = summarize(`playing-${round}`);
    const after = summarize(`silence-${round}-after`);
    rows.push({ round, before, during, after });
    console.log(`第 ${round} 轮：静音前 ${before.level.toFixed(1)} dBFS（${before.n} 样本）`
      + ` → 播报中 ${during.level.toFixed(1)} dBFS（${during.n}）`
      + ` → 静音后 ${after.level.toFixed(1)} dBFS（${after.n}）`);
  }
  const baseline = average(rows.map((r) => average([r.before.level, r.after.level])));
  const playing = average(rows.map((r) => r.during.level));
  console.log(`\n静音均值 ${baseline.toFixed(1)} dBFS | 播报中均值 ${playing.toFixed(1)} dBFS | 差值 ${(playing - baseline).toFixed(1)} dB`);
  console.log(playing - baseline > 6
    ? '判定：回声明显串入（AEC 不足）'
    : '判定：AEC 有效，播报中麦克风没有被自己的声音灌满');
};

run().catch((error) => { console.error(error); child.kill('SIGKILL'); process.exit(1); });
