// smoke-audio-core.mjs —— 音频内核协议冒烟测试
//
// 验证：①启动即报 ready ②play 播完报 finished ③中途 stop 报 stopped
//      ④能观察到自适应底噪 ⑤退出干净
//
// 用法：node test/smoke-audio-core.mjs [音频文件]

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = join(HERE, '..', 'engine', 'audio-core');

/**
 * 挑一个测试音频。
 *
 * ⚠️ 早期写法是**写死一个缓存文件名**，但缓存目录会被 prune（上限 300 个 mp3）——
 *    那个文件一旦被清掉，这条冒烟测试就**永久假失败**，与代码好坏无关，纯属测试脆弱。
 *    现在：命令行参数优先，否则从缓存目录里挑一个**当前存在的** mp3。
 * @returns 音频绝对路径，或 undefined（缓存为空）。
 */
function pickAudio() {
  if (process.argv[2] !== undefined) return process.argv[2];
  const cache = join(homedir(), '.cache', 'dsh-stage-speak');
  try {
    const found = readdirSync(cache).filter((name) => name.endsWith('.mp3')).sort()[0];
    return found === undefined ? undefined : join(cache, found);
  } catch {
    return undefined;
  }
}

const audio = pickAudio();
if (!existsSync(CORE)) {
  console.error(`找不到内核：${CORE}\n先跑 engine/build-audio-core.sh`);
  process.exit(1);
}
if (audio === undefined || !existsSync(audio)) {
  console.error(`缓存里没有可用的 mp3：${audio ?? '(缓存目录为空)'}
可以显式指定一个：node test/smoke-audio-core.mjs <某个.mp3>`);
  process.exit(1);
}

const failures = [];
const events = [];
const child = spawn(CORE, [], { stdio: ['pipe', 'pipe', 'pipe'] });

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
      events.push({ at: Date.now(), event });
      console.log(`  ← ${JSON.stringify(event)}`);
    } catch {
      console.log(`  ← (非 JSON) ${text}`);
    }
  }
});
child.stderr.on('data', (chunk) => {
  const text = chunk.toString('utf8').trim();
  if (text !== '') console.log(`  [stderr] ${text}`);
});

const send = (object) => child.stdin.write(`${JSON.stringify(object)}\n`);
const waitFor = (predicate, timeoutMs, label) => new Promise((resolve) => {
  const started = Date.now();
  const timer = setInterval(() => {
    const hit = events.find(predicate);
    if (hit !== undefined) { clearInterval(timer); resolve(hit); return; }
    if (Date.now() - started > timeoutMs) { clearInterval(timer); resolve(undefined); return; }
  }, 50);
  if (label !== undefined) process.stdout.write(`  … 等 ${label}\n`);
});

const main = async () => {
  const ready = await waitFor((e) => e.event.ev === 'ready', 5000);
  if (ready === undefined) failures.push('启动后没收到 ready');
  else {
    console.log(`  ready: ${ready.event.sampleRate}Hz ch=${ready.event.channels} 触发门限=底噪+${ready.event.speechOverFloorDb}dB`);
  }

  // ping 一下，看自适应底噪有没有在工作
  send({ cmd: 'ping' });
  const pong = await waitFor((e) => e.event.ev === 'pong', 3000);
  if (pong === undefined) failures.push('ping 没有回 pong');
  else console.log(`  底噪读数: ${pong.event.noiseFloorDb} dBFS`);

  // 完整播一遍
  console.log('  ▶ 完整播放测试（会出声）');
  send({ cmd: 'play', path: audio, id: 'smoke-1' });
  const started = await waitFor((e) => e.event.ev === 'started' && e.event.id === 'smoke-1', 3000);
  if (started === undefined) failures.push('play 没有回 started');
  const finished = await waitFor((e) => e.event.ev === 'finished' && e.event.id === 'smoke-1', 20000);
  if (finished === undefined) failures.push('播放没有自然结束（没收到 finished）');
  else console.log(`  播放时长约 ${((finished.at - started.at) / 1000).toFixed(1)}s`);

  // 中途打断
  console.log('  ▶ 打断测试（会出声后被打断）');
  send({ cmd: 'play', path: audio, id: 'smoke-2' });
  await waitFor((e) => e.event.ev === 'started' && e.event.id === 'smoke-2', 3000);
  await new Promise((r) => setTimeout(r, 800));
  const stopAt = Date.now();
  send({ cmd: 'stop', reason: 'smoke-test' });
  const stopped = await waitFor((e) => e.event.ev === 'stopped' && e.event.id === 'smoke-2', 3000);
  if (stopped === undefined) failures.push('stop 没有回 stopped');
  else console.log(`  打断延迟 ${stopped.at - stopAt}ms`);

  // 退出
  send({ cmd: 'quit' });
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 3000);
    child.on('close', () => { clearTimeout(timer); resolve(true); });
  });
  if (!exited) { failures.push('quit 后进程没有退出'); child.kill('SIGKILL'); }
};

main().finally(() => {
  console.log('--- 结果 ---');
  if (failures.length > 0) {
    console.log(failures.map((f) => `  ✗ ${f}`).join('\n'));
    process.exit(1);
  }
  console.log('  ✓ 协议冒烟测试全部通过');
});
