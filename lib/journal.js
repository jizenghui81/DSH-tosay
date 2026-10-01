// journal.js — 可选的播报日志。
//
// 两个用途：
//   1) 用户回看"刚才到底念了什么"（语音播报是瞬时的，没有回放就很虚）；
//   2) 排障：确认插件真的在跑、边界到底有没有被判定出来。
//
// 写文件失败只记日志，绝不影响播报。

import { appendFileSync } from 'node:fs';

/**
 * 建一个日志写入器。
 * @param {string} path - 目标文件；空串表示关闭。
 * @returns {{write: (kind: string, detail?: string) => void, enabled: boolean}}
 */
export function createJournal(path) {
  const target = typeof path === 'string' ? path.trim() : '';
  if (target === '') return { write: () => {}, enabled: false };

  return {
    enabled: true,
    /**
     * 追加一行日志。
     * @param {string} kind - 事件类别。
     * @param {string} detail - 附加说明。
     */
    write(kind, detail = '') {
      try {
        const stamp = new Date().toISOString();
        const line = detail === '' ? `${stamp}\t${kind}` : `${stamp}\t${kind}\t${detail}`;
        appendFileSync(target, line.replace(/\r?\n/g, ' ') + '\n', 'utf8');
      } catch { /* 写日志失败无所谓 */ }
    },
  };
}
