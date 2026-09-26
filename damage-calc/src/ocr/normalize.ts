/** NFKC 正規化（全角英数→半角）、空白除去、マイナス記号の統一 */
export function normalizeText(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[−‒–—―﹣]/g, '-')
    .replace(/\s+/g, '');
}

export function levenshtein(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      cur.push(Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost));
    }
    prev = cur;
  }
  return prev[y.length]!;
}

/** 正規化編集距離による類似度 = 1 − 距離 / 長い方の長さ */
export function similarity(a: string, b: string): number {
  const len = Math.max([...a].length, [...b].length);
  return len === 0 ? 1 : 1 - levenshtein(a, b) / len;
}

/** OCR の信頼度つきの1文字 */
export interface WChar {
  ch: string;
  conf: number; // 0..100
}

// 信頼度の低い文字は「読み違えているかもしれない文字」なので、置換・削除を安くする（信頼度60以上は通常どおり1）
const softCost = (conf: number) => Math.min(1, Math.max(0.15, conf / 60));

/**
 * 信頼度で重み付けした編集距離による類似度。信頼度100の文字だけなら similarity と同じ。
 * 置換・削除のコストはその文字の信頼度に応じて下がり、挿入（辞書側にしかない文字）は1。
 */
export function weightedSimilarity(text: WChar[], target: string): number {
  const y = [...target];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= text.length; i++) {
    const c = text[i - 1]!;
    const w = softCost(c.conf);
    const cur = [prev[0]! + w];
    for (let j = 1; j <= y.length; j++) {
      const sub = c.ch === y[j - 1] ? 0 : w;
      cur.push(Math.min(prev[j]! + w, cur[j - 1]! + 1, prev[j - 1]! + sub));
    }
    prev = cur;
  }
  const len = Math.max(text.length, y.length);
  return len === 0 ? 1 : 1 - prev[y.length]! / len;
}
