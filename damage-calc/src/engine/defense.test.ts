import { describe, expect, it } from 'vitest';
import { defaultData } from './data';
import { effectiveDefense } from './defense';

describe('effectiveDefense', () => {
  it('防御UP 25% + 防御DOWN 50% → 実効 -25%', () => {
    const r = effectiveDefense(10, { defUp: 25, defDown: 50, defDownUnique: 0 }, defaultData);
    expect(r.net).toBeCloseTo(-0.25, 10);
    expect(r.value).toBeCloseTo(7.5, 10);
  });
  it('防御DOWN 70% → 下限の -50%', () => {
    const r = effectiveDefense(10, { defUp: 0, defDown: 70, defDownUnique: 0 }, defaultData);
    expect(r.net).toBeCloseTo(-0.5, 10);
    expect(r.value).toBeCloseTo(5, 10);
  });
  it('特殊な防御DOWNで -50% からさらに下げられるが下限は -60%', () => {
    expect(effectiveDefense(10, { defUp: 0, defDown: 50, defDownUnique: 10 }, defaultData).net).toBeCloseTo(-0.6, 10);
    expect(effectiveDefense(10, { defUp: 0, defDown: 70, defDownUnique: 30 }, defaultData).net).toBeCloseTo(-0.6, 10);
    expect(effectiveDefense(10, { defUp: 0, defDown: 30, defDownUnique: 10 }, defaultData).net).toBeCloseTo(-0.4, 10);
  });
  it('補正なしは基礎防御そのまま', () => {
    expect(effectiveDefense(15, { defUp: 0, defDown: 0, defDownUnique: 0 }, defaultData).value).toBe(15);
  });
});
