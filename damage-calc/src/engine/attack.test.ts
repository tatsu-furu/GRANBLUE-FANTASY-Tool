import { describe, expect, it } from 'vitest';
import { calculate, computeFrames } from './attack';
import { defaultData, randomValues } from './data';
import { softCap } from './softcap';
import { atk, caAttack, makeInput, mod, normalAttack, skillAttack } from './testutil';
import type { AttackResult, CalcInput } from './types';

const only = (input: CalcInput, id: string): AttackResult => {
  const r = calculate(input).find((a) => a.attackId === id);
  if (!r) throw new Error(`attack ${id} not found`);
  return r;
};

describe('攻撃力の枠', () => {
  it('枠同士は乗算: マグナ 20% + EX 18% → 1.416 倍', () => {
    const { product } = computeFrames([atk('magna', 20), atk('ex', 18)], 'normal', 'neutral', defaultData);
    expect(product).toBeCloseTo(1.416, 12);
  });
  it('同じ枠は加算: マグナ 20% + マグナ 20% → 1.4 倍', () => {
    const { product, frames } = computeFrames([atk('magna', 20), atk('magna', 20)], 'normal', 'neutral', defaultData);
    expect(product).toBeCloseTo(1.4, 12);
    expect(frames.magna).toBeCloseTo(1.4, 12);
  });
  it('属性: 有利 1.5 / 等倍 1.0 / 不利 0.75、属性加護は同じ枠に加算', () => {
    const f = (rel: 'advantage' | 'neutral' | 'disadvantage', mods = [atk('element', 0)]) =>
      computeFrames(mods, 'normal', rel, defaultData).frames.element;
    expect(f('advantage')).toBeCloseTo(1.5, 12);
    expect(f('neutral')).toBeCloseTo(1.0, 12);
    expect(f('disadvantage')).toBeCloseTo(0.75, 12);
    expect(f('advantage', [atk('element', 20)])).toBeCloseTo(1.7, 12);
  });
  it('別枠は補正1つごとに乗算', () => {
    const { frames } = computeFrames([atk('unique', 10), atk('unique', 20)], 'normal', 'neutral', defaultData);
    expect(frames.unique).toBeCloseTo(1.1 * 1.2, 12);
  });
  it('未知の枠は計算に入れず報告する', () => {
    const r = computeFrames([atk('nonexistent', 50)], 'normal', 'neutral', defaultData);
    expect(r.product).toBe(1);
    expect(r.unknownFrames).toEqual(['nonexistent']);
  });
  it('パネル値の加護: panelValuesIncludeAura OFF のときだけ加護倍率を掛ける', () => {
    const panelMagna = mod({ kind: 'atk', frame: 'magna', value: 20, source: 'panel', aura: 'magna' });
    const on = makeInput({ buffs: [panelMagna], panel: { enhance: { normal: 20, magna: 280, k: 0 } } });
    const off = { ...on, assumptions: { ...on.assumptions, panelValuesIncludeAura: false } };
    expect(only(on, 'normal').perHit.breakdown.frames.magna).toBeCloseTo(1.2, 12);
    expect(only(off, 'normal').perHit.breakdown.frames.magna).toBeCloseTo(1 + 0.2 * 3.8, 12);
  });
});

describe('1ヒットのダメージと乱数', () => {
  it('防御で割る: 基礎攻撃力 10,000・防御10 → 1,000（乱数 0.95〜1.05 の平均）', () => {
    const r = only(makeInput({ attacks: [normalAttack()] }), 'normal');
    expect(r.perHit.breakdown.raw).toBeCloseTo(10_000, 9);
    expect(r.perHit.breakdown.afterDef).toBeCloseTo(1_000, 9);
    expect(r.perHit.mean).toBeCloseTo(1_000, 9);
    expect(r.perHit.min).toBeCloseTo(950, 9);
    expect(r.perHit.max).toBeCloseTo(1_050, 9);
  });
  it('最終のみ切り捨て: 1,000.5 → 1,000（浮動小数の誤差で1少なくならない）', () => {
    const input = makeInput({ baseAtk: 10_005, attacks: [normalAttack()], assumptions: { roundingMode: 'final' } });
    const r = only(input, 'normal');
    expect(r.perHit.breakdown.final).toBe(1_000);
    expect(r.perHit.min).toBe(950);
  });
  it('減衰は乱数11通りをそれぞれ通してから平均する', () => {
    const r = only(makeInput({ baseAtk: 6_000_000, attacks: [normalAttack()] }), 'normal');
    const rs = randomValues(defaultData);
    expect(rs).toHaveLength(11);
    const expected = rs.reduce((s, x) => s + softCap(600_000 * x, defaultData.softcaps.tables.normal!, 0, 0), 0) / rs.length;
    expect(r.perHit.mean).toBeCloseTo(expected, 6);
    expect(r.perHit.mean).toBeLessThan(softCap(600_000, defaultData.softcaps.tables.normal!, 0, 0));
  });
  it('防御UP/DOWN を反映する', () => {
    const r = only(
      makeInput({ attacks: [normalAttack()], enemy: { baseDef: 20 }, buffs: [mod({ kind: 'defDown', value: 50 })] }),
      'normal',
    );
    expect(r.perHit.breakdown.defEff).toBeCloseTo(10, 9);
    expect(r.perHit.breakdown.afterDef).toBeCloseTo(1_000, 9);
  });
  it('無効にした補正は計算に入らない', () => {
    const r = only(makeInput({ attacks: [normalAttack()], buffs: [atk('normal', 50, { enabled: false })] }), 'normal');
    expect(r.perHit.breakdown.frames.normal).toBe(1);
  });
});

describe('クリティカル', () => {
  const crit = (rate: number, value: number) => mod({ kind: 'crit', critRate: rate, value });
  it('有利属性で 50% の確率で +50%: 期待値は 1.25 倍', () => {
    const r = only(makeInput({ relation: 'advantage', attacks: [normalAttack()], buffs: [crit(50, 50)] }), 'normal');
    expect(r.perHit.mean).toBeCloseTo(1_000 * 1.5 * 1.25, 6);
    expect(r.critChance).toBeCloseTo(0.5, 12);
    expect(r.perHit.max).toBeCloseTo(1_500 * 1.05 * 1.5, 6);
  });
  it('複数行は独立に判定し、発生した行の倍率を加算する', () => {
    const r = only(
      makeInput({ relation: 'advantage', attacks: [normalAttack()], buffs: [crit(50, 50), crit(20, 30)] }),
      'normal',
    );
    expect(r.perHit.mean).toBeCloseTo(1_500 * (1 + 0.5 * 0.5 + 0.2 * 0.3), 6);
    expect(r.critChance).toBeCloseTo(1 - 0.5 * 0.8, 12);
  });
  it('有利属性でなければ発生しない', () => {
    const r = only(makeInput({ relation: 'neutral', attacks: [normalAttack()], buffs: [crit(100, 50)] }), 'normal');
    expect(r.perHit.mean).toBeCloseTo(1_000, 6);
    expect(r.critChance).toBe(0);
    expect(r.warnings.join()).toContain('有利属性');
  });
  it('クリティカルありとなしを別々に減衰に通して重み付けする', () => {
    const table = defaultData.softcaps.tables.normal!;
    const r = only(
      makeInput({ baseAtk: 4_000_000, relation: 'advantage', attacks: [normalAttack()], buffs: [crit(50, 100)] }),
      'normal',
    );
    const rs = randomValues(defaultData);
    const expected =
      rs.reduce((s, x) => s + 0.5 * softCap(600_000 * x, table, 0, 0) + 0.5 * softCap(1_200_000 * x, table, 0, 0), 0) /
      rs.length;
    expect(r.perHit.mean).toBeCloseTo(expected, 6);
  });
});

describe('連撃と1ターン期待値', () => {
  it('DA 15%・TA 10% → 1.335 ヒット × 1ヒット期待値', () => {
    const r = only(
      makeInput({ attacks: [normalAttack()], buffs: [mod({ kind: 'da', value: 15, appliesTo: ['normal'] }), mod({ kind: 'ta', value: 10, appliesTo: ['normal'] })] }),
      'normal',
    );
    expect(r.multiattack?.hits).toBeCloseTo(1.335, 12);
    expect(r.perTurn).toBeCloseTo(1_335, 6);
  });
  it('キャラ固有の基礎 DA/TA を足す', () => {
    const r = only(makeInput({ attacks: [normalAttack()], character: { baseDA: 100 } }), 'normal');
    expect(r.multiattack?.hits).toBeCloseTo(2, 12);
  });
  it('追撃は別ヒットとして1ヒットごとに足す（既定は減衰後ダメージ基準）', () => {
    const r = only(makeInput({ attacks: [normalAttack()], buffs: [mod({ kind: 'echo', value: 20, appliesTo: ['normal'] })] }), 'normal');
    expect(r.echo?.perHitMean).toBeCloseTo(200, 6);
    expect(r.perTurn).toBeCloseTo(1_200, 6);
  });
});

describe('減衰後の補正（与ダメUP・与ダメ上昇・特殊上限）', () => {
  it('通常攻撃: 減衰後 × (1 + Amp) → + 与ダメ上昇', () => {
    const r = only(
      makeInput({ attacks: [normalAttack()], buffs: [mod({ kind: 'amp', value: 10 }), mod({ kind: 'supp', value: 50_000, appliesTo: ['normal', 'ca'] })] }),
      'normal',
    );
    expect(r.perHit.breakdown.afterAmp).toBeCloseTo(1_100, 6);
    expect(r.perHit.breakdown.final).toBeCloseTo(51_100, 6);
  });
  it('奥義: (減衰後 + 与ダメ上昇) × (1 + Amp)', () => {
    const r = only(
      makeInput({ attacks: [caAttack()], buffs: [mod({ kind: 'amp', value: 10 }), mod({ kind: 'supp', value: 50_000, appliesTo: ['normal', 'ca'] })] }),
      'ca',
    );
    expect(r.perHit.breakdown.afterDef).toBeCloseTo(4_500, 6);
    expect(r.perHit.breakdown.final).toBeCloseTo((4_500 + 50_000) * 1.1, 6);
  });
  it('天司系は最大値1つだけ、その他は合計', () => {
    const r = only(
      makeInput({
        attacks: [normalAttack()],
        buffs: [mod({ kind: 'amp', value: 10, seraphic: true }), mod({ kind: 'amp', value: 20, seraphic: true }), mod({ kind: 'amp', value: 5 })],
      }),
      'normal',
    );
    expect(r.perHit.breakdown.ampSeraphic).toBeCloseTo(0.2, 12);
    expect(r.perHit.breakdown.ampOther).toBeCloseTo(0.05, 12);
    expect(r.perHit.breakdown.afterAmp).toBeCloseTo(1_250, 6);
  });
  it('対有利与ダメは有利属性のときだけ（advAmpOnlyVsAdvantage）', () => {
    const adv = mod({ kind: 'amp', value: 25, condition: 'vsAdvantage' });
    const neutral = only(makeInput({ attacks: [normalAttack()], buffs: [adv] }), 'normal');
    const advantage = only(makeInput({ relation: 'advantage', attacks: [normalAttack()], buffs: [adv] }), 'normal');
    const flagOff = only(makeInput({ attacks: [normalAttack()], buffs: [adv], assumptions: { advAmpOnlyVsAdvantage: false } }), 'normal');
    expect(neutral.perHit.breakdown.ampOther).toBe(0);
    expect(advantage.perHit.breakdown.ampOther).toBeCloseTo(0.25, 12);
    expect(flagOff.perHit.breakdown.ampOther).toBeCloseTo(0.25, 12);
  });
  it('対有利与ダメを天司系扱いにするフラグ', () => {
    const buffs = [mod({ kind: 'amp', value: 25, condition: 'vsAdvantage' }), mod({ kind: 'amp', value: 30, seraphic: true })];
    const r = only(makeInput({ relation: 'advantage', attacks: [normalAttack()], buffs, assumptions: { advAmpIsSeraphic: true } }), 'normal');
    expect(r.perHit.breakdown.ampSeraphic).toBeCloseTo(0.3, 12);
    expect(r.perHit.breakdown.ampOther).toBe(0);
  });
  it('特殊上限: 通常攻撃は上限の後に与ダメ上昇を足す', () => {
    const noCap = normalAttack({ capTableKey: 'custom' });
    const r = only(
      makeInput({ baseAtk: 100_000_000, attacks: [noCap], enemy: { specialCap: '6.6M' }, buffs: [mod({ kind: 'supp', value: 50_000, appliesTo: ['normal'] })] }),
      'normal',
    );
    expect(r.perHit.breakdown.final).toBe(6_650_000);
  });
  it('特殊上限: 奥義は与ダメ上昇込みで上限にかかる', () => {
    const r = only(
      makeInput({ baseAtk: 100_000_000, attacks: [caAttack({ capTableKey: 'custom' })], enemy: { specialCap: '6.6M' }, buffs: [mod({ kind: 'supp', value: 50_000, appliesTo: ['ca'] })] }),
      'ca',
    );
    expect(r.perHit.breakdown.final).toBe(6_600_000);
  });
});

describe('上限UP・上限突破', () => {
  const panelCap = (value: number, appliesTo: CalcInput['attacks'][number]['type'][]) =>
    mod({ kind: 'capUp', value, appliesTo, source: 'panel' });
  it('武器（パネル）の上限UPは通常攻撃で合計20%まで', () => {
    const r = only(makeInput({ attacks: [normalAttack()], buffs: [panelCap(20, ['normal', 'ca', 'skill']), panelCap(10, ['normal'])] }), 'normal');
    expect(r.perHit.breakdown.capUp).toBeCloseTo(0.2, 12);
    expect(r.perHit.breakdown.penetration).toBe(0);
  });
  it('capPenetrationActive なら上限を超えた分を上限突破として扱う', () => {
    const r = only(
      makeInput({ attacks: [normalAttack()], buffs: [panelCap(20, ['normal', 'ca', 'skill']), panelCap(10, ['normal'])], assumptions: { capPenetrationActive: true } }),
      'normal',
    );
    expect(r.perHit.breakdown.penetration).toBeCloseTo(0.1, 12);
  });
  it('バフの上限UPは武器の上限と別に加算', () => {
    const r = only(makeInput({ attacks: [normalAttack()], buffs: [panelCap(30, ['normal']), mod({ kind: 'capUp', value: 10, source: 'buff' })] }), 'normal');
    expect(r.perHit.breakdown.capUp).toBeCloseTo(0.3, 12);
  });
  it('奥義は武器の上限UPが100%まで', () => {
    const r = only(makeInput({ attacks: [caAttack()], buffs: [panelCap(20, ['normal', 'ca', 'skill']), panelCap(5, ['ca'])] }), 'ca');
    expect(r.perHit.breakdown.capUp).toBeCloseTo(0.25, 12);
  });
});

describe('奥義・アビ', () => {
  it('奥義: 武器の奥義ダメUP と バフの奥義ダメUP は別々に乗算', () => {
    const r = only(
      makeInput({
        attacks: [caAttack()],
        buffs: [mod({ kind: 'caDmg', value: 10, source: 'panel', appliesTo: ['ca'] }), mod({ kind: 'caDmg', value: 20, source: 'buff', appliesTo: ['ca'] })],
      }),
      'ca',
    );
    expect(r.perHit.breakdown.multiplier).toBeCloseTo(4.5 * 1.1 * 1.2, 12);
  });
  it('奥義の固定値は減衰前に足す', () => {
    const r = only(makeInput({ attacks: [caAttack({ fixedDamage: 1_000 })] }), 'ca');
    expect(r.perHit.breakdown.afterDef).toBeCloseTo(5_500, 9);
  });
  it('奥義は既定でクリティカルしない', () => {
    const r = only(makeInput({ relation: 'advantage', attacks: [caAttack()], buffs: [mod({ kind: 'crit', critRate: 100, value: 50 })] }), 'ca');
    expect(r.critChance).toBe(0);
  });
  it('アビ: 倍率とアビダメUPは加算', () => {
    const r = only(makeInput({ attacks: [skillAttack()], buffs: [mod({ kind: 'skillDmg', value: 20, appliesTo: ['skill'] })] }), 'skill');
    expect(r.perHit.breakdown.multiplier).toBeCloseTo(5.2, 12);
    expect(r.perHit.breakdown.afterDef).toBeCloseTo(5_200, 9);
  });
  it('アビの減衰表が未入力なら減衰なしで計算して警告する', () => {
    const r = only(makeInput({ attacks: [skillAttack()] }), 'skill');
    expect(r.perHit.breakdown.afterCap).toBeCloseTo(r.perHit.breakdown.afterDef, 9);
    expect(r.warnings.join()).toContain('減衰表');
  });
  it('アビの減衰表（ユーザー入力）を使う', () => {
    const customCap = { thresholds: [1_000, 2_000, 3_000, 4_000], reductions: [0, 50, 50, 50, 99] };
    const r = only(makeInput({ attacks: [skillAttack({ customCap })] }), 'skill');
    expect(r.perHit.breakdown.afterCap).toBeCloseTo(1_000 + 1_000 * 0.5 + 1_000 * 0.5 + 1_000 * 0.5 + 1_000 * 0.01, 6);
  });
});

describe('各枠 +10% の伸び率', () => {
  it('減衰前なら通常攻刃 +10% はそのまま +10%', () => {
    const r = only(makeInput({ attacks: [normalAttack()] }), 'normal');
    expect(r.marginal.normal).toBeCloseTo(0.1, 9);
    expect(r.marginalExtra.capUp).toBeCloseTo(0, 9);
  });
  it('減衰域では攻刃の伸びは小さく、上限UPの伸びが大きい', () => {
    const r = only(makeInput({ baseAtk: 10_000_000, attacks: [normalAttack()] }), 'normal');
    expect(r.marginal.magna!).toBeLessThan(0.01);
    expect(r.marginalExtra.capUp).toBeGreaterThan(0.05);
  });
  it('基礎攻撃力が 0 なら伸び率も 0 で、警告を出す', () => {
    const r = only(makeInput({ baseAtk: 0, attacks: [normalAttack()] }), 'normal');
    expect(r.marginal.normal).toBe(0);
    expect(r.warnings.join()).toContain('基礎攻撃力');
  });
});
