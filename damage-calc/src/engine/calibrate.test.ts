import { describe, expect, it } from 'vitest';
import {
  SEARCH_FLAGS,
  advantageTarget,
  calibrate,
  estimateDamage,
  forwardCheck,
  searchHypotheses,
  searchHypothesesMulti,
} from './calibrate';
import { makeInput, mod } from './testutil';
import type { CalcInput } from './types';

// パネル由来: マグナ 100%、与ダメUP 10%、与ダメ上昇 +50000
const panelMods = () => [
  mod({ kind: 'atk', frame: 'magna', value: 100, source: 'panel' }),
  mod({ kind: 'amp', value: 10, source: 'panel' }),
  mod({ kind: 'supp', value: 50_000, appliesTo: ['normal', 'ca'], source: 'panel' }),
];

const base = (baseAtk: number, extra: Partial<CalcInput['assumptions']> = {}): CalcInput =>
  makeInput({ baseAtk, relation: 'advantage', buffs: panelMods(), assumptions: { roundingMode: 'none', ...extra } });

describe('estimateDamage（予測ダメージ: 防御10・通常攻撃1回・戦闘中バフなし）', () => {
  it('無印は属性等倍、対属性は有利で計算する', () => {
    const input = base(1_000_000);
    expect(estimateDamage(input, 'plain')).toBeCloseTo(200_000 * 1.1 + 50_000, 6);
    expect(estimateDamage(input, 'vs')).toBeCloseTo(300_000 * 1.1 + 50_000, 6);
  });
  it('戦闘中バフ・敵防御の補正は含めない', () => {
    const input = base(1_000_000);
    const withBuffs: CalcInput = {
      ...input,
      enemy: { ...input.enemy, baseDef: 20 },
      buffs: [...input.buffs, mod({ kind: 'atk', frame: 'normal', value: 50, source: 'buff' }), mod({ kind: 'defDown', value: 50 })],
    };
    expect(estimateDamage(withBuffs, 'plain')).toBeCloseTo(estimateDamage(input, 'plain'), 6);
  });
  it('仮定フラグで減衰・与ダメUP・与ダメ上昇を外せる', () => {
    const input = base(1_000_000, { estimateIncludesAmp: false, estimateIncludesSupp: false });
    expect(estimateDamage(input, 'plain')).toBeCloseTo(200_000, 6);
  });
});

describe('forwardCheck（順算）', () => {
  it('誤差を比で返す', () => {
    const input = base(1_000_000);
    const r = forwardCheck(input, { plain: 270_000 * 1.01, vsElement: { element: 'earth', value: 380_000 } });
    expect(r.plainError).toBeCloseTo(1 / 1.01 - 1, 9);
    expect(r.vsError).toBeCloseTo(0, 9);
  });
});

describe('calibrate（逆算）', () => {
  it('基礎攻撃力を逆算して対属性で答え合わせ', () => {
    const truth = base(1_234_567);
    const target = {
      plain: estimateDamage(truth, 'plain'),
      vsElement: { element: 'earth' as const, value: estimateDamage(truth, 'vs') },
    };
    const r = calibrate(base(0), target, 'baseAtk');
    expect(r.solvedValue! / 1_234_567).toBeCloseTo(1, 8);
    expect(r.plainError).toBeCloseTo(0, 8);
    expect(r.vsError).toBeCloseTo(0, 8);
  });
  it('属性加護を逆算する（基礎攻撃力は既知）', () => {
    const truth: CalcInput = { ...base(1_000_000), buffs: [...panelMods(), mod({ kind: 'atk', frame: 'element', value: 20, source: 'manual' })] };
    const r = calibrate(base(1_000_000), { plain: estimateDamage(truth, 'plain') }, 'elementAura');
    expect(r.solvedValue).toBeCloseTo(20, 6);
  });
  it('解が範囲内に無ければ null とメッセージ', () => {
    // 減衰を含めない仮定では上限UPを変えても予測ダメージは 270,000 のまま
    const input = base(1_000_000, { estimateIncludesSoftCap: false });
    const r = calibrate(input, { plain: 300_000 }, 'capUpNormal');
    expect(r.solvedValue).toBeNull();
    expect(r.message).toBeTruthy();
  });
  it('基礎攻撃力が 0 のまま他の未知数は解けない', () => {
    const r = calibrate(base(0), { plain: 270_000 }, 'elementAura');
    expect(r.solvedValue).toBeNull();
  });
});

describe('searchHypotheses（仮説探索）', () => {
  it(`仮説フラグ ${SEARCH_FLAGS.length} 個 × 丸め3通りを全探索する`, () => {
    const truth = base(1_000_000);
    const target = { plain: estimateDamage(truth, 'plain'), vsElement: { element: 'earth' as const, value: estimateDamage(truth, 'vs') } };
    const results = searchHypotheses(base(0), target, 'baseAtk');
    expect(results).toHaveLength(2 ** SEARCH_FLAGS.length * 3);
  });
  it('予測ダメージが減衰なしで作られていれば、その仮説が上位に来る', () => {
    const truth = base(3_000_000, { estimateIncludesSoftCap: false });
    const target = { plain: estimateDamage(truth, 'plain'), vsElement: { element: 'earth' as const, value: estimateDamage(truth, 'vs') } };
    const results = searchHypotheses(base(0), target, 'baseAtk');
    expect(Math.abs(results[0]!.vsError!)).toBeLessThan(1e-9);
    expect(results[0]!.assumptions.estimateIncludesSoftCap).toBe(false);
    for (const r of results.filter((x) => Math.abs(x.vsError ?? 1) < 1e-6)) {
      expect(r.assumptions.estimateIncludesSoftCap).toBe(false);
    }
  });
});

describe('searchHypothesesMulti（複数スクショで一括）', () => {
  it('全サンプルの誤差を合わせて最小の仮説を探す', () => {
    const hidden = { estimateIncludesSoftCap: false } as const;
    const samples = [2_000_000, 3_000_000].map((atk, i) => {
      const truth = base(atk, hidden);
      return {
        id: `s${i}`,
        name: `サンプル${i + 1}`,
        input: base(0),
        target: { plain: estimateDamage(truth, 'plain'), vsElement: { element: 'earth' as const, value: estimateDamage(truth, 'vs') } },
      };
    });
    const results = searchHypothesesMulti(samples, 'baseAtk');
    expect(results[0]!.rmsError).toBeLessThan(1e-9);
    expect(results[0]!.assumptions.estimateIncludesSoftCap).toBe(false);
    expect(results[0]!.perSample).toHaveLength(2);
  });
});

describe('advantageTarget', () => {
  it('風は土に有利、光と闇は互いに有利', () => {
    expect(advantageTarget('wind')).toBe('earth');
    expect(advantageTarget('fire')).toBe('wind');
    expect(advantageTarget('light')).toBe('dark');
    expect(advantageTarget('dark')).toBe('light');
  });
});
