import { describe, expect, it } from 'vitest';
import { defaultData, randomValues } from './data';
import { ATTACK_TYPES } from './types';

const { softcaps, frames, labels, formula } = defaultData;
const frameIds = new Set(frames.frames.map((f) => f.id));

describe('data/softcaps.json', () => {
  for (const [key, t] of Object.entries(softcaps.tables)) {
    it(`${key}: 減衰率は閾値より1つ多く、閾値は昇順、減衰率は 0〜100`, () => {
      expect(t.reductions).toHaveLength(t.thresholds.length + 1);
      expect([...t.thresholds].sort((a, b) => a - b)).toEqual(t.thresholds);
      for (const r of t.reductions) expect(r >= 0 && r <= 100).toBe(true);
    });
  }
  it('アビのプリセットは閾値と減衰率がそろって入っているか、そろって未入力', () => {
    for (const p of Object.values(softcaps.skillPresets)) {
      expect(p.thresholds === null).toBe(p.reductions === null);
      if (p.thresholds && p.reductions) expect(p.reductions).toHaveLength(p.thresholds.length + 1);
    }
  });
  it('武器の上限UPの上限が3種別ぶんある', () => {
    for (const t of ATTACK_TYPES) expect(typeof softcaps.capUpLimits.weapon[t]).toBe('number');
  });
  it('"_doc" は読み込み時に取り除かれる', () => {
    expect(Object.keys(softcaps.skillPresets)).not.toContain('_doc');
    expect(Object.keys(softcaps.specialCaps).sort()).toEqual(['13.1M', '6.6M', 'none']);
  });
});

describe('data/labels.json', () => {
  it('ID が重複しない', () => {
    const ids = labels.labels.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('攻撃力の割り当て先は frames.json にある枠', () => {
    for (const l of labels.labels) {
      if (l.slot.kind === 'atk') expect(frameIds.has(l.slot.frame), `${l.name} → ${l.slot.frame}`).toBe(true);
    }
  });
  it('表示名は aliases に含まれ、範囲は [最小, 最大]', () => {
    for (const l of labels.labels) {
      expect(l.aliases).toContain(l.name);
      expect(l.range[0]).toBeLessThan(l.range[1]);
    }
  });
});

describe('data/formula.json', () => {
  it('乱数は 0.95〜1.05 の11通り', () => {
    const rs = randomValues(defaultData);
    expect(rs).toHaveLength(11);
    expect(rs[0]).toBe(0.95);
    expect(rs[10]).toBe(1.05);
  });
  it('減衰後の補正が3種別ぶんある', () => {
    for (const t of ATTACK_TYPES) expect(formula.postCap[t]).toBeDefined();
  });
});
