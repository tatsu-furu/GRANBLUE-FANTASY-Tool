import { softCap } from './softcap';
import type { Assumptions, CapTable, Modifier, PostCapRule } from './types';

/** 特殊上限（段階的な減衰。上限UP・上限突破は効かない） */
export interface SpecialCap {
  value: number;
  table: CapTable;
}

export interface AmpTotals {
  seraphic: number; // 天司系の最大値（小数）
  other: number; // その他の合計（小数）
}

/** 与ダメUP = 1 + 天司系（最大値1つだけ）+ その他の合計 */
export function ampTotals(mods: Modifier[], valueOf: (m: Modifier) => number, assumptions: Assumptions): AmpTotals {
  const seraphic: number[] = [];
  let other = 0;
  for (const m of mods) {
    if (m.kind !== 'amp') continue;
    const v = valueOf(m) / 100;
    const isSeraphic = m.seraphic === true || (m.condition === 'vsAdvantage' && assumptions.advAmpIsSeraphic);
    if (isSeraphic) seraphic.push(v);
    else other += v;
  }
  return { seraphic: seraphic.length > 0 ? Math.max(...seraphic) : 0, other };
}

export interface PostCapStages {
  afterAmp: number; // 減衰後 × (1 + Amp)（与ダメ上昇を除く）
  final: number;
  hitSpecialCap: boolean;
}

/**
 * 減衰後の補正。rule（data/formula.json の postCap）で種別ごとの違いを切り替える。
 * 特殊上限も段階的な減衰（gbf.wiki Damage Cap）。
 * 通常攻撃: 減衰後 × (1 + Amp) → 特殊上限 → + 与ダメ上昇
 * 奥義・アビ: (減衰後 + 与ダメ上昇) × (1 + Amp) → 特殊上限
 */
export function applyPostCap(
  afterCap: number,
  amp: AmpTotals,
  supp: number,
  specialCap: SpecialCap | null,
  rule: PostCapRule,
  round: (x: number) => number,
): PostCapStages {
  const ampMult = 1 + amp.seraphic + amp.other;
  const suppMult =
    1 +
    (rule.suppAmplifiedBy.includes('seraphic') ? amp.seraphic : 0) +
    (rule.suppAmplifiedBy.includes('other') ? amp.other : 0);
  const limit = (x: number) => (specialCap ? softCap(x, specialCap.table, 0, 0) : x);
  const over = (x: number) => specialCap !== null && x > (specialCap.table.thresholds[0] ?? Infinity);
  const afterAmp = round(afterCap * ampMult);
  const suppPart = supp * suppMult;
  if (rule.suppBeforeSpecialCap) {
    const pre = afterAmp + suppPart;
    return { afterAmp, final: limit(pre), hitSpecialCap: over(pre) };
  }
  return { afterAmp, final: limit(afterAmp) + suppPart, hitSpecialCap: over(afterAmp) };
}
