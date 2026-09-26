// 単語を行にまとめ、「発動中の武器スキル」より下を2列グリッドとして左右のセルに分ける。
import type { LabelData } from '../engine/types';
import { matchHeader } from './match';
import type { OcrWord } from './types';

const cy = (w: OcrWord) => w.bbox.y + w.bbox.h / 2;

/** y 座標で行にまとめる（中心の差が高さの半分未満なら同じ行）。行の中は x の昇順 */
export function groupLines(words: OcrWord[]): OcrWord[][] {
  const sorted = words.filter((w) => w.text.trim() !== '').sort((a, b) => cy(a) - cy(b));
  const lines: { words: OcrWord[]; cy: number; h: number }[] = [];
  for (const w of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(cy(w) - last.cy) < 0.5 * Math.max(last.h, w.bbox.h)) {
      last.words.push(w);
      last.cy = last.words.reduce((s, x) => s + cy(x), 0) / last.words.length;
      last.h = Math.max(last.h, w.bbox.h);
    } else {
      lines.push({ words: [w], cy: cy(w), h: w.bbox.h });
    }
  }
  return lines.map((l) => l.words.sort((a, b) => a.bbox.x - b.bbox.x));
}

export function findHeadingIndex(lines: OcrWord[][], labels: LabelData): number {
  return lines.findIndex((l) => matchHeader(l.map((w) => w.text).join(''), labels) === 'gridHeading');
}

/** グリッドの左右の境目。グリッド行の単語が占める範囲の中央（きっちり切り抜いた画像なら画像幅の中央と同じ） */
export function gridSplitX(lines: OcrWord[][]): number | null {
  const ws = lines.flat();
  if (ws.length === 0) return null;
  const left = Math.min(...ws.map((w) => w.bbox.x));
  const right = Math.max(...ws.map((w) => w.bbox.x + w.bbox.w));
  return (left + right) / 2;
}

export function splitCells(line: OcrWord[], x: number): [OcrWord[], OcrWord[]] {
  const left: OcrWord[] = [];
  const right: OcrWord[] = [];
  for (const w of line) (w.bbox.x + w.bbox.w / 2 < x ? left : right).push(w);
  return [left, right];
}
