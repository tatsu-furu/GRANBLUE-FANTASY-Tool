import type { LabelData } from '../engine/types';
import { normalizeText, similarity, weightedSimilarity, type WChar } from './normalize';

export interface LabelCandidate {
  id: string;
  similarity: number; // 辞書照合の類似度（信頼度で重み付けした編集距離）
  score: number; // 並べ替え用: 類似度 + 値の妥当性 + 確認済みの項目を少し優先
}

const PLAUSIBILITY_PENALTY = 0.15; // 値の単位・範囲がその項目に合わない
const CONFIRMED_BONUS = 0.005; // 同点なら「想定」より「スクショで確認済み」の項目

export function rankLabels(chars: WChar[], value: { value: number; unit: '%' | 'flat' } | null, labels: LabelData): LabelCandidate[] {
  return labels.labels
    .map((l) => {
      const sim = Math.max(...l.aliases.map((a) => weightedSimilarity(chars, normalizeText(a))));
      let score = sim + (l.status === 'confirmed' ? CONFIRMED_BONUS : 0);
      if (value && (value.unit !== l.unit || value.value < l.range[0] || value.value > l.range[1])) score -= PLAUSIBILITY_PENALTY;
      return { id: l.id, similarity: sim, score };
    })
    .sort((a, b) => b.score - a.score);
}

export interface LabelMatch {
  id: string | null; // 類似度が閾値未満なら null（未分類）
  score: number; // 採用した項目の類似度
  bestId: string; // 閾値未満でも最も近かった項目
  ambiguous: boolean; // 次点との差が小さい
}

const AMBIGUOUS_MARGIN = 0.05;
const TAKEN_PENALTY = 0.2; // 1枚のパネルに同じ項目は普通1回しか出ないので、割り当て済みの項目は下げる

/**
 * パネル全体でまとめて割り当てる。スコアの高いセルから順に決め、割り当て済みの項目は他のセルで下げる。
 * 類似度が閾値未満のセルは未分類（id: null）。
 */
export function assignLabels(candidates: LabelCandidate[][], threshold: number): LabelMatch[] {
  const result: LabelMatch[] = candidates.map((c) => ({
    id: null,
    score: c[0]?.similarity ?? 0,
    bestId: c[0]?.id ?? '',
    ambiguous: false,
  }));
  const taken = new Map<string, number>();
  const done = candidates.map(() => false);
  for (let round = 0; round < candidates.length; round++) {
    let pick: { i: number; c: LabelCandidate; adj: number; margin: number } | null = null;
    candidates.forEach((cands, i) => {
      if (done[i]) return;
      const adjusted = cands
        .map((c) => ({ c, adj: c.score - TAKEN_PENALTY * (taken.get(c.id) ?? 0) }))
        .sort((a, b) => b.adj - a.adj);
      const top = adjusted[0];
      if (top && (!pick || top.adj > pick.adj)) {
        pick = { i, c: top.c, adj: top.adj, margin: top.adj - (adjusted[1]?.adj ?? -Infinity) };
      }
    });
    if (!pick) break;
    const { i, c, margin } = pick as { i: number; c: LabelCandidate; adj: number; margin: number };
    done[i] = true;
    result[i] = {
      id: c.similarity >= threshold ? c.id : null,
      score: c.similarity,
      bestId: c.id,
      ambiguous: c.similarity < 1 && margin < AMBIGUOUS_MARGIN,
    };
    if (c.similarity >= threshold) taken.set(c.id, (taken.get(c.id) ?? 0) + 1);
  }
  return result;
}

const toChars = (text: string): WChar[] => [...normalizeText(text)].map((ch) => ({ ch, conf: 100 }));

/** 1項目だけ照合する（テキストの信頼度はすべて100とみなす） */
export function matchLabel(raw: string, labels: LabelData): LabelMatch {
  return assignLabels([rankLabels(toChars(raw), null, labels)], labels.matchThreshold)[0]!;
}

export type HeaderKey = 'estimateVs' | 'estimatePlain' | 'maxHp' | 'enhance' | 'gridHeading';

/** keyword を含むか（同じ長さの窓で1文字までの誤認識を許す） */
function containsFuzzy(text: string, keyword: string): boolean {
  if (text.includes(keyword)) return true;
  const chars = [...text];
  const len = [...keyword].length;
  if (chars.length < len || len < 4) return false;
  const threshold = 1 - 1 / len;
  for (let i = 0; i + len <= chars.length; i++) {
    if (similarity(chars.slice(i, i + len).join(''), keyword) >= threshold - 1e-9) return true;
  }
  return false;
}

// 「対○属性予測ダメージ」は「予測ダメージ」も含むので先に判定する
const HEADER_ORDER: HeaderKey[] = ['estimateVs', 'estimatePlain', 'maxHp', 'enhance', 'gridHeading'];

export function matchHeader(raw: string, labels: LabelData): HeaderKey | null {
  const text = normalizeText(raw);
  for (const key of HEADER_ORDER) {
    if (labels.header[key].some((k) => containsFuzzy(text, normalizeText(k)))) return key;
  }
  return null;
}
