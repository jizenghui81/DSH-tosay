// asr-e2e.mjs —— 全双工"录音 → 云端识别"的端到端验证
//
// 做法：内核自测模式录固定时长，其间**外放一段已知文本的音频**，再把识别结果与期望文本比对。
// 这样不依赖"人对着麦克风说话"，可重复、可对照。
//
// 用法：
//   node test/asr-e2e.mjs              默认 AGC 关（当前默认）
//   node test/asr-e2e.mjs --agc-on     对照：打开 voice processing 的 AGC
//
// 密钥：从 ~/.mmx/config.json 读（与插件 wrapper 同源，仓库内不留密钥）。

import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = join(HERE, '..', 'engine', 'audio-core');
const agcOn = process.argv.includes('--agc-on');
const seconds = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 8);

// 已知文本的样本音频：读 minimax-speak 的日志找到 hash → 对应缓存 mp3
const KNOWN = {
  hash: '352f7d1fd72ee13ffa4687fabcedeb7c',
  text: '正在写Swift回声消除测试，验证外放，边听边说是否可行。实测已通过，接着再查相关目录',
};
const audio = join(homedir(), '.cache', 'dsh-stage-speak', `${KNOWN.hash}.mp3`);

function apiKey() {
  const path = join(homedir(), '.mmx', 'config.json');
  if (!existsSync(path)) return '';
  try {
    return JSON.parse(readFileSync(path, 'utf8')).api_key ?? '';
  } catch {
    return '';
  }
}

if (!existsSync(CORE)) { console.error(`找不到内核 ${CORE}，先跑 engine/build-audio-core.sh`); process.exit(1); }
if (!existsSync(audio)) { console.error(`找不到样本音频 ${audio}`); process.exit(1); }
const key = apiKey();
if (key === '') { console.error('读不到 API key（~/.mmx/config.json）'); process.exit(1); }

console.log(`模式：AGC ${agcOn ? '开' : '关'} ｜ 录制 ${seconds}s ｜ 期间外放已知音频（会出声）`);

const env = {
  ...process.env,
  ASR_ENABLED: '1',
  MINIMAX_API_KEY: key,
  ASR_TEST_SECONDS: String(seconds),
  ...(agcOn ? { VP_AGC: 'on' } : {}),
};

const child = spawn(CORE, [], { stdio: ['pipe', 'pipe', 'pipe'] });
const t0 = Date.now();
let buffer = '';
let heard = null;
let peak = null;

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    const text = line.trim();
    if (text === '') continue;
    let event;
    try { event = JSON.parse(text); } catch { continue; }
    if (event.ev === 'heartbeat') continue;
    const extra = { ...event };
    delete extra.ev;
    console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s ${event.ev} ${JSON.stringify(extra).slice(0, 170)}`);
    if (event.ev === 'utterance') heard = event.text;
    if (event.ev === 'asr-test-recorded') peak = event.peakInt16;
  }
});
child.stderr.on('data', (d) => process.stderr.write(`[core] ${d.toString().slice(0, 160)}`));

// 校准期过后开始外放（内核 ready 约 2s，校准 1.5s，故 3s 起播）
setTimeout(() => {
  try { execFileSync('/usr/bin/afplay', [audio]); } catch { /* 放音失败不影响判定 */ }
}, 3000);

child.on('close', () => {
  console.log('--- 结果 ---');
  if (peak !== null) {
    const db = peak > 0 ? (20 * Math.log10(peak / 32767)).toFixed(1) : '静音';
    console.log(`采集峰值: ${peak}/32767（${db} dBFS）`);
  }
  if (heard === null) {
    console.log('✗ 没拿到识别文本');
    process.exit(1);
  }
  const norm = (s) => s.replace(/[，。、,.!?！？\s]/g, '');
  const a = norm(heard);
  const b = norm(KNOWN.text);
  console.log('期望:', KNOWN.text);
  console.log('实得:', heard);
  if (a === b) console.log('✓ 完全一致');
  else if (a.includes(b.slice(0, 10))) console.log('✓ 开头一致（高度吻合）');
  else console.log('✗ 差异较大');
  process.exit(a === b || a.includes(b.slice(0, 10)) ? 0 : 1);
});
