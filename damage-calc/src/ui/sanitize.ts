// 共有 URL や localStorage から読んだ入力は外部データなので、型を確かめてから既定値に重ねる
import { defaultInput } from '../engine/defaults';
import {
  ATTACK_TYPES,
  type AttackSpec,
  type AttackType,
  type CalcInput,
  type Element,
  type Modifier,
  type ModifierKind,
  type PanelSkill,
  type SlotSpec,
} from '../engine/types';

const ELEMENTS: readonly Element[] = ['fire', 'water', 'earth', 'wind', 'light', 'dark'];
const KINDS: readonly ModifierKind[] = [
  'atk', 'capUp', 'capPen', 'amp', 'supp', 'da', 'ta', 'crit', 'caDmg', 'skillDmg', 'defUp', 'defDown', 'defDownUnique', 'echo',
];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const str = (v: unknown, fallback: string, max = 200) => (typeof v === 'string' ? v.slice(0, max) : fallback);
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T =>
  typeof v === 'string' && (options as readonly string[]).includes(v) ? (v as T) : fallback;
const attackTypes = (v: unknown): AttackType[] =>
  Array.isArray(v) ? ATTACK_TYPES.filter((t) => v.includes(t)) : [...ATTACK_TYPES];

function slot(v: unknown): SlotSpec | undefined {
  if (!isObj(v)) return undefined;
  switch (v.kind) {
    case 'atk':
      return { kind: 'atk', frame: str(v.frame, 'normal', 40) };
    case 'capUp':
    case 'capPen':
    case 'supp':
      return { kind: v.kind, appliesTo: attackTypes(v.appliesTo) };
    case 'amp':
      return {
        kind: 'amp',
        appliesTo: attackTypes(v.appliesTo),
        seraphic: bool(v.seraphic, false),
        condition: oneOf(v.condition, ['always', 'vsAdvantage'] as const, 'always'),
      };
    case 'da':
    case 'ta':
    case 'caDmg':
    case 'skillDmg':
    case 'echo':
    case 'display':
    case 'unclassified':
      return { kind: v.kind };
    default:
      return undefined;
  }
}

function skill(v: unknown): PanelSkill | null {
  if (!isObj(v)) return null;
  const s: PanelSkill = {
    labelRaw: str(v.labelRaw, ''),
    labelId: typeof v.labelId === 'string' ? v.labelId.slice(0, 60) : null,
    value: num(v.value, 0),
    unit: oneOf(v.unit, ['%', 'flat'] as const, '%'),
    confidence: Math.min(1, Math.max(0, num(v.confidence, 1))),
  };
  const a = slot(v.assign);
  if (a) s.assign = a;
  if (v.ignored === true) s.ignored = true;
  return s;
}

function modifier(v: unknown, i: number): Modifier | null {
  if (!isObj(v)) return null;
  const kind = oneOf(v.kind, KINDS, 'atk');
  const m: Modifier = {
    id: str(v.id, `m${i}`, 60),
    label: str(v.label, ''),
    source: oneOf(v.source, ['panel', 'buff', 'manual'] as const, 'buff'),
    kind,
    appliesTo: attackTypes(v.appliesTo),
    value: num(v.value, 0),
    enabled: bool(v.enabled, true),
  };
  if (typeof v.frame === 'string') m.frame = v.frame.slice(0, 40);
  if (typeof v.seraphic === 'boolean') m.seraphic = v.seraphic;
  if (v.condition === 'always' || v.condition === 'vsAdvantage') m.condition = v.condition;
  if (typeof v.critRate === 'number' && Number.isFinite(v.critRate)) m.critRate = v.critRate;
  if (v.aura === 'normal' || v.aura === 'magna' || v.aura === 'k') m.aura = v.aura;
  if (v.caDmgGroup === 'weapon' || v.caDmgGroup === 'buff') m.caDmgGroup = v.caDmgGroup;
  return m;
}

function capTable(v: unknown): AttackSpec['customCap'] {
  if (!isObj(v) || !Array.isArray(v.thresholds) || !Array.isArray(v.reductions)) return undefined;
  const thresholds = v.thresholds.slice(0, 12).map((x) => num(x, 0));
  const reductions = v.reductions.slice(0, 13).map((x) => num(x, 0));
  return reductions.length === thresholds.length + 1 ? { thresholds, reductions } : undefined;
}

function attack(v: unknown, i: number): AttackSpec | null {
  if (!isObj(v)) return null;
  const a: AttackSpec = {
    id: str(v.id, `a${i}`, 60),
    name: str(v.name, `攻撃${i + 1}`, 60),
    type: oneOf(v.type, ATTACK_TYPES, 'normal'),
    multiplier: num(v.multiplier, 100),
    capTableKey: str(v.capTableKey, 'custom', 60),
    enabled: bool(v.enabled, true),
  };
  const cap = capTable(v.customCap);
  if (cap) a.customCap = cap;
  if (typeof v.fixedDamage === 'number' && Number.isFinite(v.fixedDamage)) a.fixedDamage = v.fixedDamage;
  if (typeof v.canCrit === 'boolean') a.canCrit = v.canCrit;
  return a;
}

/** 不正な値は既定値で置き換えた CalcInput を返す。形がまったく違えば null */
export function sanitizeInput(raw: unknown): CalcInput | null {
  if (!isObj(raw) || raw.version !== 1) return null;
  const base = defaultInput();
  const panel = isObj(raw.panel) ? raw.panel : {};
  const enhance = isObj(panel.enhance) ? panel.enhance : {};
  const character = isObj(raw.character) ? raw.character : {};
  const enemy = isObj(raw.enemy) ? raw.enemy : {};
  const assumptions = isObj(raw.assumptions) ? raw.assumptions : {};
  const est = isObj(panel.estimate) ? panel.estimate : null;
  const vs = est && isObj(est.vsElement) ? est.vsElement : null;
  const input: CalcInput = {
    version: 1,
    panel: {
      enhance: {
        normal: num(enhance.normal, 0),
        magna: num(enhance.magna, 0),
        k: num(enhance.k, 0),
      },
      skills: Array.isArray(panel.skills) ? panel.skills.slice(0, 80).map(skill).filter((s): s is PanelSkill => s !== null) : [],
    },
    character: {
      baseAtk: num(character.baseAtk, base.character.baseAtk),
      elementRelation: oneOf(character.elementRelation, ['advantage', 'neutral', 'disadvantage'] as const, base.character.elementRelation),
      baseDA: num(character.baseDA, 0),
      baseTA: num(character.baseTA, 0),
    },
    enemy: {
      baseDef: num(enemy.baseDef, base.enemy.baseDef),
      specialCap: oneOf(enemy.specialCap, ['none', '6.6M', '13.1M'] as const, 'none'),
    },
    buffs: Array.isArray(raw.buffs) ? raw.buffs.slice(0, 80).map(modifier).filter((m): m is Modifier => m !== null) : [],
    attacks: Array.isArray(raw.attacks)
      ? raw.attacks.slice(0, 20).map(attack).filter((a): a is AttackSpec => a !== null)
      : base.attacks,
    assumptions: {
      panelValuesIncludeAura: bool(assumptions.panelValuesIncludeAura, base.assumptions.panelValuesIncludeAura),
      estimateIncludesSoftCap: bool(assumptions.estimateIncludesSoftCap, base.assumptions.estimateIncludesSoftCap),
      estimateIncludesAmp: bool(assumptions.estimateIncludesAmp, base.assumptions.estimateIncludesAmp),
      advAmpOnlyVsAdvantage: bool(assumptions.advAmpOnlyVsAdvantage, base.assumptions.advAmpOnlyVsAdvantage),
      estimateIncludesSupp: bool(assumptions.estimateIncludesSupp, base.assumptions.estimateIncludesSupp),
      plainEstimateIsNeutral: bool(assumptions.plainEstimateIsNeutral, base.assumptions.plainEstimateIsNeutral),
      capPenetrationActive: bool(assumptions.capPenetrationActive, base.assumptions.capPenetrationActive),
      roundingMode: oneOf(assumptions.roundingMode, ['none', 'final', 'each'] as const, base.assumptions.roundingMode),
      advAmpIsSeraphic: bool(assumptions.advAmpIsSeraphic, base.assumptions.advAmpIsSeraphic),
      echoBase: oneOf(assumptions.echoBase, ['afterCap', 'afterAmp', 'final'] as const, base.assumptions.echoBase),
    },
  };
  if (est && typeof est.plain === 'number' && Number.isFinite(est.plain)) {
    input.panel.estimate = { plain: est.plain };
    if (vs && typeof vs.value === 'number' && Number.isFinite(vs.value)) {
      input.panel.estimate.vsElement = { element: oneOf(vs.element, ELEMENTS, 'fire'), value: vs.value };
    }
  }
  if (typeof panel.maxHp === 'number' && Number.isFinite(panel.maxHp)) input.panel.maxHp = panel.maxHp;
  const el = oneOf(panel.element, [...ELEMENTS, ''] as const, '');
  if (el) input.panel.element = el;
  return input;
}
