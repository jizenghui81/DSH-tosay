// check-secrets.mjs — 开源前的密钥与隐私守卫。
//
// 为什么需要它：这个插件要开源到 GitHub，而"某次改动顺手把密钥或本机路径带进去"
// 是最容易发生、后果最严重的一类事故。所以把检查做成一条可复跑的命令，而不是靠人眼。
//
// 它做两件事：
//   ① 通用特征扫描 —— 密钥形态（sk-/gho_/ghp_/AKIA…）、疑似赋值、裸 Bearer、
//      以及带真实用户名的绝对家目录路径（/Users/<name>/ 这类隐私泄漏）。
//   ② 真值比对 —— 把**本机真实存在的密钥**读进内存逐字比对，确认仓库里没有它。
//      密钥值只存在于运行时内存，绝不写进本脚本（否则守卫自己就成了泄漏源）。
//
// 跑法：
//   npm run check-secrets
//   MINIMAX_API_KEY=sk-xxx npm run check-secrets     # 额外比对指定值
//
// 退出码：0 = 干净；1 = 有命中（详情已打印，命中片段做掩码处理）。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage']);
const SKIP_FILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']);

/** 通用密钥/隐私特征。注意：这些正则的字面文本本身不会匹配自身。 */
const PATTERNS = [
  { name: 'API Key 形态 (sk-…)', re: /sk-[A-Za-z0-9_-]{20,}/g },
  { name: 'GitHub Token', re: /(?:gho_|ghp_|ghu_|ghs_|github_pat_)[A-Za-z0-9_]{20,}/g },
  { name: 'AWS Access Key', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'Slack Token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'JWT / 长 base64 令牌', re: /eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}/g },
  { name: '裸 Bearer 令牌', re: /Bearer\s+[A-Za-z0-9._-]{20,}/g },
  {
    name: '疑似密钥赋值',
    re: /(?:api[_-]?key|apikey|secret|token|password|passwd)\s*[:=]\s*["'][^"'\s]{16,}["']/gi,
  },
  {
    name: '带用户名的绝对家目录路径（隐私）',
    re: /\/(?:Users|home)\/(?!<|\$|user\b|username\b)[A-Za-z0-9._-]{2,}\//g,
  },
];

/** 已知无害的命中（放行，避免守卫吵闹导致被绕过）。 */
const ALLOW = [
  /const secret = 42/, // test/offline.mjs 里用于验证 Markdown 清洗的代码块样例
];

/** 递归收集待扫描文件。 */
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(entry.name)) continue;
      out.push(full);
    }
  }
  return out;
}

/** 命中片段掩码，避免把真密钥打到终端/CI 日志里。 */
function mask(hit) {
  if (hit.length <= 12) return '***';
  return `${hit.slice(0, 6)}***${hit.slice(-3)} (len=${hit.length})`;
}

/** 收集本机真实密钥（只进内存，绝不落盘）。 */
function localSecrets() {
  const found = [];
  const envKey = process.env.MINIMAX_API_KEY;
  if (typeof envKey === 'string' && envKey.trim().length >= 16) {
    found.push({ label: 'MINIMAX_API_KEY 环境变量', value: envKey.trim() });
  }
  const cfg = process.env.MMX_CONFIG || path.join(os.homedir(), '.mmx', 'config.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    if (typeof parsed.api_key === 'string' && parsed.api_key.length >= 16) {
      found.push({ label: `${cfg} 的 api_key`, value: parsed.api_key });
    }
  } catch { /* 没有就算了 */ }
  return found;
}

const files = walk(REPO);
const hits = [];

for (const file of files) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    continue; // 二进制或不可读，跳过
  }
  const rel = path.relative(REPO, file);
  const lines = text.split('\n');

  for (const { name, re } of PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      re.lastIndex = 0;
      const match = re.exec(line);
      if (match === null) continue;
      if (ALLOW.some((a) => a.test(line))) continue;
      hits.push({ rel, line: i + 1, kind: name, sample: mask(match[0]) });
    }
  }
}

// ② 真值比对：本机真实密钥与真实用户名不得出现在仓库任何文件里。
//    和密钥一样，这些值只从本机读取、只进内存 —— 守卫自身不硬编码任何私人字符串。
const USERNAME = (() => {
  try {
    return os.userInfo().username;
  } catch {
    return '';
  }
})();
const secrets = localSecrets();
if (USERNAME !== '') secrets.push({ label: `本机用户名（${USERNAME}）`, value: USERNAME });
let secretLeak = 0;
for (const { label, value } of secrets) {
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!text.includes(value)) continue;
    const rel = path.relative(REPO, file);
    // 报出所有出现位置（同一文件里可能有多处），最多 10 处，避免刷屏
    let idx = text.indexOf(value);
    let shown = 0;
    while (idx !== -1 && shown < 10) {
      const lineNo = text.slice(0, idx).split('\n').length;
      hits.push({ rel, line: lineNo, kind: `本机真值泄漏（${label}）`, sample: mask(value) });
      secretLeak += 1;
      shown += 1;
      idx = text.indexOf(value, idx + value.length);
    }
    if (idx !== -1) hits.push({ rel, line: 0, kind: `本机真值泄漏（${label}）`, sample: '…还有更多，只列了前 10 处' });
  }
}

console.log(`扫描 ${files.length} 个文件（已跳过 node_modules/ 与锁文件）`);
console.log(`比对的本机真值来源：${secrets.length === 0 ? '无' : secrets.map((s) => s.label).join('、')}`);
console.log('');

if (hits.length === 0) {
  console.log('✅ 干净：仓库内未发现密钥、令牌或带用户名的家目录路径。');
  process.exit(0);
}

console.error(`❌ 发现 ${hits.length} 处问题：\n`);
for (const h of hits) {
  console.error(`  ${h.rel}:${h.line}  [${h.kind}]  ${h.sample}`);
}
console.error('\n修掉之后再提交。⚠️ 若密钥**已经**进入 git 历史，删除文件是不够的 —— 必须改密钥 + 重写历史。');
process.exit(1);
