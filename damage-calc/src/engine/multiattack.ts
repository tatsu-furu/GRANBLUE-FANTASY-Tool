export interface MultiattackRates {
  pTA: number;
  pDA: number;
  pSA: number;
  hits: number; // 1ターンの期待ヒット数
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** 先に TA 判定、外れたら DA 判定。引数は %（基礎 + 武器 + バフの合計） */
export function multiattackRates(daPercent: number, taPercent: number): MultiattackRates {
  const t = clamp01(taPercent / 100);
  const d = clamp01(daPercent / 100);
  const pTA = t;
  const pDA = (1 - t) * d;
  const pSA = (1 - t) * (1 - d);
  return { pTA, pDA, pSA, hits: 3 * pTA + 2 * pDA + pSA };
}
