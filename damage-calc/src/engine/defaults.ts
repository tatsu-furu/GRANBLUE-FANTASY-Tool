import { defaultData } from './data';
import type { Assumptions, AttackSpec, CalcInput, EngineData, PanelValues } from './types';

export function defaultAssumptions(): Assumptions {
  return {
    panelValuesIncludeAura: true,
    estimateIncludesSoftCap: true,
    estimateIncludesAmp: true,
    advAmpOnlyVsAdvantage: true,
    estimateIncludesSupp: true,
    plainEstimateIsNeutral: true,
    capPenetrationActive: false,
    roundingMode: 'final',
    advAmpIsSeraphic: false,
    echoBase: 'afterCap',
  };
}

export function defaultAttacks(data: EngineData = defaultData): AttackSpec[] {
  return [
    { id: 'normal', name: '通常攻撃', type: 'normal', multiplier: 100, capTableKey: 'normal', enabled: true },
    {
      id: 'ca',
      name: '奥義',
      type: 'ca',
      multiplier: data.formula.attackDefaults.caMultiplier,
      capTableKey: 'ca',
      fixedDamage: 0,
      enabled: true,
    },
    {
      id: 'skill-1',
      name: 'アビリティ1',
      type: 'skill',
      multiplier: data.formula.attackDefaults.skillMultiplier,
      capTableKey: 'custom',
      enabled: true,
    },
  ];
}

export function emptyPanel(): PanelValues {
  return { enhance: { normal: 0, magna: 0, k: 0 }, skills: [] };
}

export function defaultInput(data: EngineData = defaultData): CalcInput {
  return {
    version: 1,
    panel: emptyPanel(),
    character: { baseAtk: 0, elementRelation: 'advantage', baseDA: 0, baseTA: 0 },
    enemy: { baseDef: data.formula.defense.presets[0] ?? 10, specialCap: 'none' },
    buffs: [],
    attacks: defaultAttacks(data),
    assumptions: defaultAssumptions(),
  };
}
