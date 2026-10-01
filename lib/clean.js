// clean.js — 把给模型看的文本洗成适合朗读的文本。
//
// 语音引擎对 Markdown 的容忍度极低：反引号、竖线表格、URL、emoji 会被逐字念出来，
// 或者让 SAPI 静默失败。这一层只做纯文本变换，零依赖、可单测。

/** 代码块占位语（念代码没有意义）。 */
const CODE_PLACEHOLDER = '代码略';

/** emoji 与常见装饰符号的码位区间。 */
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2460}-\u{24FF}\u{25A0}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{20E3}]/gu;

/**
 * 把任意文本洗成一句可朗读的话。
 * @param {unknown} input - 原始文本（非字符串一律返回空串）。
 * @returns {string} 适合朗读的纯文本。
 */
export function cleanForSpeech(input) {
  if (typeof input !== 'string' || input.length === 0) return '';
  let s = input;

  // 围栏代码块（含 ``` 与 ~~~）先整块替换，避免块内内容被后续规则逐行处理。
  s = s.replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm, ' ' + CODE_PLACEHOLDER + ' ');
  s = s.replace(/(```|~~~)[\s\S]*?\1/g, ' ' + CODE_PLACEHOLDER + ' ');

  // 行内代码与强调标记：去掉标记保留内容。
  s = s.replace(/`([^`\n]*)`/g, '$1');
  s = s.replace(/(\*\*|__)([\s\S]*?)\1/g, '$2');
  s = s.replace(/(\*|_)(?=\S)([\s\S]*?\S)\1/g, '$2');

  // 图片整个丢掉；链接保留可读文字。
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

  // 裸 URL 没有朗读价值。
  s = s.replace(/\bhttps?:\/\/\S+/gi, '链接');
  s = s.replace(/\bwww\.\S+/gi, '链接');

  // 行首结构符号：标题、引用、列表、有序列表。
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '');
  s = s.replace(/^[ \t]{0,3}>[ \t]?/gm, '');
  s = s.replace(/^[ \t]{0,3}[-*+][ \t]+/gm, '');
  s = s.replace(/^[ \t]{0,3}\d+[.)][ \t]+/gm, '');

  // 表格：整行是 | a | b | 的直接丢掉；分隔行也丢掉。
  s = s.replace(/^[ \t]*\|.*\|[ \t]*$/gm, ' ');
  s = s.replace(/^[ \t]*[-=*_]{3,}[ \t]*$/gm, ' ');

  // emoji 与装饰符。
  s = s.replace(EMOJI_RE, '');

  // 归一空白。
  s = s.replace(/[ \t\u00A0]+/g, ' ').replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();

  return s;
}

/**
 * 按字符上限截断，尽量落在句末，读起来不会断在半句上。
 * @param {string} text - 已清洗的文本。
 * @param {number} maxChars - 上限；<= 0 表示不截断。
 * @returns {string} 截断后的文本。
 */
export function truncateForSpeech(text, maxChars) {
  if (typeof text !== 'string') return '';
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) return text;
  const window = text.slice(0, maxChars);
  // 中文句末一律算；英文句末要求后面是空白/收尾，避免把 "0.1." 当句末。
  const cut = Math.max(
    window.lastIndexOf('。'),
    window.lastIndexOf('！'),
    window.lastIndexOf('？'),
    window.lastIndexOf('；'),
    window.lastIndexOf('…'),
  );
  if (cut >= Math.floor(maxChars * 0.5)) return window.slice(0, cut + 1);
  return window.trimEnd() + '…';
}
