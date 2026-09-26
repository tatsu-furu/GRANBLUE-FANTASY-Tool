// テスト用の入力ビルダー（テストからのみ使う）
import { defaultInput } from './defaults';
import type { AttackSpec, CalcInput, Modifier } from './types';

let seq = 0;

export function mod(partial: Partial<Modifier> & Pick<Modifier, 'kind'>): Modifier {
  seq += 1;
  return {
    id: `t${seq}`,
    label: partial.kind,
    source: 'manual',
    appliesTo: ['normal', 'ca', 'skill'],
    value: 0,
    enabled: true,
    ...partial,
  };
}

export function atk(frame: string, value: number, extra: Partial<Modifier> = {}): Modifier {
  return mod({ kind: 'atk', frame, value, ...extra });
}

export function makeInput(p: {
  baseAtk?: number;
  relation?: CalcInput['character']['elementRelation'];
  buffs?: Modifier[];
  attacks?: AttackSpec[];
  assumptions?: Partial<CalcInput['assumptions']>;
  enemy?: Partial<CalcInput['enemy']>;
  character?: Partial<CalcInput['character']>;
  panel?: Partial<CalcInput['panel']>;
}): CalcInput {
  const base = defaultInput();
  return {
    ...base,
    panel: { ...base.panel, ...p.panel },
    character: {
      ...base.character,
      baseAtk: p.baseAtk ?? 10_000,
      elementRelation: p.relation ?? 'neutral',
      ...p.character,
    },
    enemy: { ...base.enemy, ...p.enemy },
    buffs: p.buffs ?? [],
    attacks: p.attacks ?? base.attacks,
    assumptions: { ...base.assumptions, roundingMode: 'none', ...p.assumptions },
  };
}

export const normalAttack = (extra: Partial<AttackSpec> = {}): AttackSpec => ({
  id: 'normal',
  name: '通常攻撃',
  type: 'normal',
  multiplier: 100,
  capTableKey: 'normal',
  ...extra,
});

export const caAttack = (extra: Partial<AttackSpec> = {}): AttackSpec => ({
  id: 'ca',
  name: '奥義',
  type: 'ca',
  multiplier: 450,
  capTableKey: 'ca',
  ...extra,
});

export const skillAttack = (extra: Partial<AttackSpec> = {}): AttackSpec => ({
  id: 'skill',
  name: 'アビ',
  type: 'skill',
  multiplier: 500,
  capTableKey: 'custom',
  ...extra,
});
