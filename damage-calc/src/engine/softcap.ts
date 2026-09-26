import type { AttackSpec, CapTable, EngineData, SkillExtraCapBand, SoftcapData } from './types';

/**
 * 区分線形の減衰。capUp（上限UP）は閾値すべてに (1 + capUp) を掛け、
 * penetration（上限突破）は各区間の減衰率 r を 1 − (1 − r)(1 + penetration) に置き換える（0 未満にはしない）。
 * capUp・penetration は小数（0.2 = 20%）、table.reductions は %。
 */
export function softCap(x: number, table: CapTable, capUp = 0, penetration = 0): number {
  const scale = 1 + capUp;
  let result = 0;
  let lower = 0;
  for (let i = 0; i < table.reductions.length; i++) {
    if (x <= lower) break;
    const t = table.thresholds[i];
    const upper = t === undefined ? Infinity : t * scale;
    const r = (table.reductions[i] ?? 0) / 100;
    const rEff = Math.max(0, 1 - (1 - r) * (1 + penetration));
    result += (Math.min(x, upper) - lower) * (1 - rEff);
    lower = upper;
  }
  return result;
}

export interface ExtraCapResult {
  value: number;
  applied: boolean; // 倍率帯に当てはまり追加減衰を計算した
  missingData: boolean; // 対象の倍率なのに倍率帯の表が無い
  band: SkillExtraCapBand | null;
}

/** 倍率 600% 以下のアビに掛かる減衰後の追加減衰。baseMultiplier はアビダメUPを含まない素の倍率(%)。 */
export function applySkillExtraCap(
  y: number,
  baseMultiplier: number,
  capUp: number,
  cfg: SoftcapData['skillExtraCap'],
): ExtraCapResult {
  if (baseMultiplier > cfg.maxMultiplier) return { value: y, applied: false, missingData: false, band: null };
  const band = [...cfg.bands].sort((a, b) => a.maxMultiplier - b.maxMultiplier).find((b) => baseMultiplier <= b.maxMultiplier);
  if (!band) return { value: y, applied: false, missingData: true, band: null };
  const scale = cfg.scaleWithCapUp ? 1 + capUp : 1;
  const t1 = band.t1 * scale;
  const t2 = band.t2 * scale;
  const keepBetween = 1 - cfg.cutBetween / 100;
  const keepAbove = 1 - cfg.cutAbove / 100;
  let value = y;
  if (y > t2) value = t1 + (t2 - t1) * keepBetween + (y - t2) * keepAbove;
  else if (y > t1) value = t1 + (y - t1) * keepBetween;
  return { value, applied: true, missingData: false, band };
}

export interface ResolvedCapTable {
  table: CapTable | null; // null = 減衰表なし（未入力）
  name: string;
}

export function resolveCapTable(attack: AttackSpec, data: EngineData): ResolvedCapTable {
  if (attack.capTableKey === 'custom') {
    const t = attack.customCap;
    const valid = t && t.thresholds.length > 0 && t.reductions.length === t.thresholds.length + 1;
    return valid ? { table: t, name: '技ごとの減衰表' } : { table: null, name: '減衰表なし（未入力）' };
  }
  const preset = data.softcaps.skillPresets[attack.capTableKey];
  if (preset) {
    return preset.thresholds && preset.reductions
      ? { table: { thresholds: preset.thresholds, reductions: preset.reductions }, name: preset.name }
      : { table: null, name: `${preset.name}（減衰表が未転記）` };
  }
  const def = data.softcaps.tables[attack.capTableKey];
  return def ? { table: def, name: def.name } : { table: null, name: `不明な減衰表: ${attack.capTableKey}` };
}

/** 減衰グラフ用に [0, xMax] を n 等分した点を返す */
export function capCurve(table: CapTable, capUp: number, penetration: number, xMax: number, n: number): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= n; i++) {
    const x = (xMax * i) / n;
    pts.push({ x, y: softCap(x, table, capUp, penetration) });
  }
  return pts;
}
