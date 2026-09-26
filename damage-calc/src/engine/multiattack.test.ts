import { describe, expect, it } from 'vitest';
import { multiattackRates } from './multiattack';

describe('multiattackRates（TA 判定 → 外れたら DA 判定）', () => {
  it('TA 10%、DA 15% → 1.335 ヒット/ターン', () => {
    const r = multiattackRates(15, 10);
    expect(r.pTA).toBeCloseTo(0.1, 12);
    expect(r.pDA).toBeCloseTo(0.135, 12);
    expect(r.pSA).toBeCloseTo(0.765, 12);
    expect(r.hits).toBeCloseTo(1.335, 12);
  });
  it('確率の合計は1', () => {
    const r = multiattackRates(37, 21);
    expect(r.pTA + r.pDA + r.pSA).toBeCloseTo(1, 12);
  });
  it('0〜100% にクランプする', () => {
    expect(multiattackRates(0, 130).hits).toBe(3);
    expect(multiattackRates(-20, -5).hits).toBe(1);
    expect(multiattackRates(250, 0).hits).toBe(2);
  });
});
