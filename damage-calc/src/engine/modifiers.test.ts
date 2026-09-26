import { describe, expect, it } from 'vitest';
import expected from '../../fixtures/panel-001.json';
import { calculate } from './attack';
import { defaultData } from './data';
import { defaultInput } from './defaults';
import { collectModifiers, panelToModifiers } from './modifiers';
import { panelFromExpected } from './sample';
import type { Modifier, PanelValues } from './types';

const labels = defaultData.labels;
const panel: PanelValues = panelFromExpected(expected, labels);

const byLabel = (mods: Modifier[], label: string) => mods.filter((m) => m.label === label);

describe('panelFromExpected（期待値 JSON → パネル値）', () => {
  it('20項目すべてが辞書の ID に対応する', () => {
    expect(panel.skills).toHaveLength(20);
    expect(panel.skills.every((s) => s.labelId !== null)).toBe(true);
    expect(panel.estimate?.vsElement?.element).toBe('earth');
    expect(panel.enhance.magna).toBe(280);
  });
});

describe('panelToModifiers（辞書どおりの枠に振り分ける）', () => {
  const mods = panelToModifiers(panel, labels);

  it('表示のみ（HP・防御・奥義ゲージ）と未分類（嵐竜方陣）は計算に入れない', () => {
    expect(mods).toHaveLength(16);
    for (const name of ['HP', '防御', '奥義ゲージ上昇量', '嵐竜方陣']) expect(byLabel(mods, name)).toHaveLength(0);
  });
  it('攻刃系は系統ごとの枠へ', () => {
    expect(byLabel(mods, '攻刃')[0]).toMatchObject({ kind: 'atk', frame: 'normal', value: 54, aura: 'normal', source: 'panel' });
    expect(byLabel(mods, 'M攻刃')[0]).toMatchObject({ kind: 'atk', frame: 'magna', value: 296, aura: 'magna' });
    expect(byLabel(mods, 'EX攻刃')[0]).toMatchObject({ kind: 'atk', frame: 'ex', value: 56 });
    expect(byLabel(mods, 'EX攻刃(特殊)')[0]).toMatchObject({ kind: 'atk', frame: 'ex', value: 40 });
    expect(byLabel(mods, 'M渾身')[0]).toMatchObject({ kind: 'atk', frame: 'magna_stamina', value: 72.31 });
  });
  it('上限UP は汎用と種別で対象が違う', () => {
    expect(byLabel(mods, 'D上限')[0]).toMatchObject({ kind: 'capUp', appliesTo: ['normal', 'ca', 'skill'], value: 20 });
    expect(byLabel(mods, '通常D上限')[0]).toMatchObject({ kind: 'capUp', appliesTo: ['normal'] });
    expect(byLabel(mods, 'アビD上限')[0]).toMatchObject({ kind: 'capUp', appliesTo: ['skill'], value: 91.8 });
    expect(byLabel(mods, '奥義D上限')[0]).toMatchObject({ kind: 'capUp', appliesTo: ['ca'] });
  });
  it('与ダメUP・与ダメ上昇・連撃・奥義ダメUP', () => {
    expect(byLabel(mods, 'M与ダメ')[0]).toMatchObject({ kind: 'amp', condition: 'always', seraphic: false, value: 7.6 });
    expect(byLabel(mods, '対有利与ダメ')[0]).toMatchObject({ kind: 'amp', condition: 'vsAdvantage', value: 25 });
    expect(byLabel(mods, '与ダメージ')[0]).toMatchObject({ kind: 'supp', appliesTo: ['normal', 'ca'], value: 50_000 });
    expect(byLabel(mods, 'アビ与ダメ')[0]).toMatchObject({ kind: 'supp', appliesTo: ['skill'], value: 190_000 });
    expect(byLabel(mods, 'DA確率')[0]).toMatchObject({ kind: 'da', appliesTo: ['normal'], value: 15 });
    expect(byLabel(mods, 'TA確率')[0]).toMatchObject({ kind: 'ta', appliesTo: ['normal'], value: 10 });
    expect(byLabel(mods, '奥義D')[0]).toMatchObject({ kind: 'caDmg', caDmgGroup: 'weapon', appliesTo: ['ca'], value: 10 });
  });
  it('未分類に枠を割り当てると計算に入る', () => {
    const assigned: PanelValues = {
      ...panel,
      skills: panel.skills.map((s) => (s.labelId === 'storm_dragon' ? { ...s, assign: { kind: 'atk', frame: 'unique' } } : s)),
    };
    expect(byLabel(panelToModifiers(assigned, labels), '嵐竜方陣')[0]).toMatchObject({ kind: 'atk', frame: 'unique', value: 60 });
  });
  it('無視にした項目は計算に入らない', () => {
    const ignored: PanelValues = { ...panel, skills: panel.skills.map((s) => (s.labelId === 'magna_might' ? { ...s, ignored: true } : s)) };
    expect(byLabel(panelToModifiers(ignored, labels), 'M攻刃')).toHaveLength(0);
  });
});

describe('collectModifiers', () => {
  it('戦闘中バフを除く指定（予測ダメージ用）ではパネルと常時補正だけを返す', () => {
    const input = {
      ...defaultInput(),
      panel,
      buffs: [
        { id: 'b', label: 'バフ', source: 'buff' as const, kind: 'atk' as const, frame: 'normal', appliesTo: ['normal' as const], value: 20, enabled: true },
        { id: 'm', label: 'EMP', source: 'manual' as const, kind: 'atk' as const, frame: 'char_stamina', appliesTo: ['normal' as const], value: 10, enabled: true },
      ],
    };
    const all = collectModifiers(input, defaultData, { includeBattleBuffs: true });
    const passive = collectModifiers(input, defaultData, { includeBattleBuffs: false });
    expect(all).toHaveLength(18);
    expect(passive).toHaveLength(17);
    expect(passive.some((m) => m.id === 'b')).toBe(false);
  });
});

describe('スクショの値での計算（スモークテスト）', () => {
  it('通常攻撃・奥義・アビの結果が有限値で、最小 ≤ 平均 ≤ 最大', () => {
    const input = { ...defaultInput(), panel, character: { ...defaultInput().character, baseAtk: 50_000 } };
    const results = calculate(input);
    expect(results.map((r) => r.type)).toEqual(['normal', 'ca', 'skill']);
    for (const r of results) {
      expect(Number.isFinite(r.perHit.mean)).toBe(true);
      expect(r.perHit.min).toBeLessThanOrEqual(r.perHit.mean + 1e-9);
      expect(r.perHit.mean).toBeLessThanOrEqual(r.perHit.max + 1e-9);
    }
    expect(results[0]!.perTurn).toBeGreaterThan(results[0]!.perHit.mean);
  });
});
