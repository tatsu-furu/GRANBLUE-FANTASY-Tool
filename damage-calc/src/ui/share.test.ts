import { describe, expect, it } from 'vitest';
import expected from '../../fixtures/panel-001.json';
import { defaultData } from '../engine/data';
import { defaultInput } from '../engine/defaults';
import { panelFromExpected } from '../engine/sample';
import type { CalcInput } from '../engine/types';
import { sanitizeInput } from './sanitize';
import { decodeShareHash, encodeShareHash } from './share';

const sample = (): CalcInput => {
  const base = defaultInput();
  const panel = panelFromExpected(expected, defaultData.labels);
  panel.skills[0]!.bbox = [1, 2, 3, 4];
  return {
    ...base,
    panel,
    character: { ...base.character, baseAtk: 54_321, baseDA: 7 },
    buffs: [{ id: 'b1', label: '攻撃UP', source: 'buff', kind: 'atk', frame: 'unique', appliesTo: ['normal'], value: 20, enabled: true }],
    assumptions: { ...base.assumptions, estimateIncludesSoftCap: false, roundingMode: 'each' },
  };
};

describe('共有 URL', () => {
  it('入力一式を往復できる（座標は落とす）', () => {
    const input = sample();
    const hash = encodeShareHash(input);
    expect(hash.startsWith('#s=')).toBe(true);
    const back = decodeShareHash(hash)!;
    expect(back.character).toEqual(input.character);
    expect(back.buffs).toEqual(input.buffs);
    expect(back.assumptions).toEqual(input.assumptions);
    expect(back.panel.estimate).toEqual(input.panel.estimate);
    expect(back.panel.skills).toHaveLength(20);
    expect(back.panel.skills[0]!.bbox).toBeUndefined();
    expect(back.panel.skills.map((s) => [s.labelId, s.value])).toEqual(input.panel.skills.map((s) => [s.labelId, s.value]));
  });
  it('壊れたハッシュは null', () => {
    expect(decodeShareHash('#s=@@@')).toBeNull();
    expect(decodeShareHash('#other')).toBeNull();
  });
});

describe('sanitizeInput（外部データの検証）', () => {
  it('型の違う値は既定値に置き換える', () => {
    const r = sanitizeInput({
      version: 1,
      character: { baseAtk: 'abc', elementRelation: 'weird', baseDA: 5 },
      enemy: { baseDef: Infinity, specialCap: '6.6M' },
      buffs: [{ kind: 'nope', value: 'x' }, 42],
    })!;
    expect(r.character.baseAtk).toBe(0);
    expect(r.character.elementRelation).toBe('advantage');
    expect(r.character.baseDA).toBe(5);
    expect(r.enemy).toEqual({ baseDef: 10, specialCap: '6.6M' });
    expect(r.buffs).toHaveLength(1);
    expect(r.buffs[0]).toMatchObject({ kind: 'atk', value: 0 });
    expect(r.attacks).toHaveLength(3);
  });
  it('version が違えば null', () => {
    expect(sanitizeInput({ version: 2 })).toBeNull();
    expect(sanitizeInput(null)).toBeNull();
  });
});
