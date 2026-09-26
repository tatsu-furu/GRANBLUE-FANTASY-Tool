import { ATTACK_TYPES } from './types';
import type { AuraSystem, CalcInput, EngineData, LabelData, Modifier, PanelValues, SlotSpec } from './types';

interface SlotBase {
  id: string;
  label: string;
  value: number;
  aura?: AuraSystem;
}

/** 辞書の割り当て先（slot）を Modifier に変換する。表示のみ・未分類は null */
export function slotToModifier(slot: SlotSpec, base: SlotBase): Modifier | null {
  const common = { ...base, source: 'panel' as const, enabled: true };
  switch (slot.kind) {
    case 'atk':
      return { ...common, kind: 'atk', frame: slot.frame, appliesTo: [...ATTACK_TYPES] };
    case 'capUp':
    case 'capPen':
    case 'supp':
      return { ...common, kind: slot.kind, appliesTo: [...slot.appliesTo] };
    case 'amp':
      return {
        ...common,
        kind: 'amp',
        appliesTo: [...slot.appliesTo],
        seraphic: slot.seraphic ?? false,
        condition: slot.condition ?? 'always',
      };
    case 'da':
    case 'ta':
    case 'echo':
      return { ...common, kind: slot.kind, appliesTo: ['normal'] };
    case 'caDmg':
      return { ...common, kind: 'caDmg', appliesTo: ['ca'], caDmgGroup: 'weapon' };
    case 'skillDmg':
      return { ...common, kind: 'skillDmg', appliesTo: ['skill'] };
    case 'display':
    case 'unclassified':
      return null;
  }
}

export function slotOf(skill: PanelValues['skills'][number], labels: LabelData): SlotSpec {
  if (skill.assign) return skill.assign;
  const def = skill.labelId ? labels.labels.find((l) => l.id === skill.labelId) : undefined;
  return def?.slot ?? { kind: 'unclassified' };
}

/** パネルの項目を Modifier のリストに変換する。エンジンはここから先、補正の出どころを気にしない */
export function panelToModifiers(panel: PanelValues, labels: LabelData): Modifier[] {
  const mods: Modifier[] = [];
  panel.skills.forEach((skill, i) => {
    if (skill.ignored) return;
    const def = skill.labelId ? labels.labels.find((l) => l.id === skill.labelId) : undefined;
    const m = slotToModifier(slotOf(skill, labels), {
      id: `panel-${i}`,
      label: def?.name ?? skill.labelRaw,
      value: skill.value,
      // 手で割り当てた項目は加護の系統が分からないので付けない
      ...(skill.assign || !def?.aura ? {} : { aura: def.aura }),
    });
    if (m) mods.push(m);
  });
  return mods;
}

/** 計算に使う補正の一覧。includeBattleBuffs が false なら戦闘中バフ（source: buff）を除く（予測ダメージ用） */
export function collectModifiers(input: CalcInput, data: EngineData, opts: { includeBattleBuffs: boolean }): Modifier[] {
  const extra = input.buffs.filter((m) => m.enabled && (opts.includeBattleBuffs || m.source !== 'buff'));
  return [...panelToModifiers(input.panel, data.labels), ...extra];
}
