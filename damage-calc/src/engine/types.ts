// 計算エンジンの型。React には依存しない。

export type Element = 'fire' | 'water' | 'earth' | 'wind' | 'light' | 'dark';
export type AttackType = 'normal' | 'ca' | 'skill';
export type ElementRelation = 'advantage' | 'neutral' | 'disadvantage';
export type FrameId = string; // frames.json のキー
export type AuraSystem = 'normal' | 'magna' | 'k';

export const ATTACK_TYPES: readonly AttackType[] = ['normal', 'ca', 'skill'];

// ---------- 入力 ----------

// 入力一式（プリセット保存・共有 URL の単位）
export interface CalcInput {
  version: 1;
  panel: PanelValues; // スクショ由来
  character: CharacterInput;
  enemy: EnemyInput;
  buffs: Modifier[]; // 戦闘中のバフ・デバフと、パネル外の常時補正
  attacks: AttackSpec[];
  assumptions: Assumptions;
}

export interface PanelValues {
  estimate?: { plain: number; vsElement?: { element: Element; value: number } };
  maxHp?: number;
  element?: Element; // ○属性スキルエンハンスの属性
  enhance: { normal: number; magna: number; k: number }; // % 表記のまま
  skills: PanelSkill[];
}

export interface PanelSkill {
  labelRaw: string; // OCR の生文字列
  labelId: string | null; // labels.json の ID、未分類は null
  value: number; // 54% は 54
  unit: '%' | 'flat';
  confidence: number; // 0..1
  bbox?: [x: number, y: number, w: number, h: number];
  // 確認フォームでの割り当て。未分類項目を枠に入れる、または辞書の割り当てを上書きする
  assign?: SlotSpec;
  // 計算から外す（無視を選んだ項目、重複して読めた低信頼度側）
  ignored?: boolean;
}

export type SlotSpec =
  | { kind: 'atk'; frame: FrameId }
  | { kind: 'capUp'; appliesTo: AttackType[] }
  | { kind: 'capPen'; appliesTo: AttackType[] }
  | { kind: 'amp'; appliesTo: AttackType[]; seraphic?: boolean; condition?: 'always' | 'vsAdvantage' }
  | { kind: 'supp'; appliesTo: AttackType[] }
  | { kind: 'da' }
  | { kind: 'ta' }
  | { kind: 'caDmg' }
  | { kind: 'skillDmg' }
  | { kind: 'echo' }
  | { kind: 'display' }
  | { kind: 'unclassified' };

export type ModifierKind =
  | 'atk'
  | 'capUp'
  | 'capPen'
  | 'amp'
  | 'supp'
  | 'da'
  | 'ta'
  | 'crit'
  | 'caDmg'
  | 'skillDmg'
  | 'defUp'
  | 'defDown'
  | 'defDownUnique'
  | 'echo';

export interface Modifier {
  id: string;
  label: string;
  // panel = スクショ、buff = 戦闘中のバフ・デバフ、manual = パネル外の常時補正（EMP・指輪など）
  source: 'panel' | 'buff' | 'manual';
  kind: ModifierKind;
  frame?: FrameId; // kind === 'atk' のとき必須
  appliesTo: AttackType[]; // 汎用は3つ全部
  value: number; // % または固定値
  seraphic?: boolean; // amp のみ
  condition?: 'always' | 'vsAdvantage';
  critRate?: number; // crit のみ（%）
  enabled: boolean;
  aura?: AuraSystem; // パネル値の加護系統（panelValuesIncludeAura が OFF のときだけ使う）
  caDmgGroup?: 'weapon' | 'buff'; // caDmg のみ。省略時は source が panel なら weapon
}

export interface CharacterInput {
  baseAtk: number;
  elementRelation: ElementRelation;
  baseDA: number; // %
  baseTA: number; // %
}

export interface EnemyInput {
  baseDef: number; // 10 / 15 / 20 / 任意
  specialCap: SpecialCapKey;
}

export type SpecialCapKey = 'none' | '6.6M' | '13.1M';

export interface CapTable {
  thresholds: number[];
  reductions: number[]; // % で thresholds より1つ多い
}

export interface AttackSpec {
  id: string;
  name: string;
  type: AttackType;
  multiplier: number; // %（通常攻撃は 100）
  capTableKey: string; // softcaps.json のキー、または 'custom'
  customCap?: CapTable; // capTableKey === 'custom' のとき。未入力なら減衰なしで計算して警告
  fixedDamage?: number; // 奥義の固定値
  canCrit?: boolean; // 省略時は formula.json の defaultCanCrit
  enabled?: boolean;
}

export type RoundingMode = 'none' | 'final' | 'each';

export interface Assumptions {
  panelValuesIncludeAura: boolean; // パネルの攻刃系の値は加護適用後
  estimateIncludesSoftCap: boolean; // 予測ダメージは減衰込み
  estimateIncludesAmp: boolean; // 予測ダメージは与ダメUP込み
  advAmpOnlyVsAdvantage: boolean; // 対有利与ダメは有利属性にだけ乗る
  estimateIncludesSupp: boolean; // 予測ダメージは与ダメ上昇込み
  plainEstimateIsNeutral: boolean; // 無印の予測ダメージは属性等倍が前提
  capPenetrationActive: boolean; // 武器の上限UPが上限を超えた分を上限突破として扱う
  roundingMode: RoundingMode;
  advAmpIsSeraphic: boolean; // 対有利与ダメを天司系（最大値1つだけ）として扱う
  echoBase: EchoBase; // 追撃の元にするダメージの段階
}

export type EchoBase = 'afterCap' | 'afterAmp' | 'final';

export const BOOLEAN_ASSUMPTION_KEYS = [
  'panelValuesIncludeAura',
  'estimateIncludesSoftCap',
  'estimateIncludesAmp',
  'advAmpOnlyVsAdvantage',
  'estimateIncludesSupp',
  'plainEstimateIsNeutral',
  'capPenetrationActive',
  'advAmpIsSeraphic',
] as const;
export type BooleanAssumptionKey = (typeof BOOLEAN_ASSUMPTION_KEYS)[number];

// ---------- データ（data/*.json） ----------

export interface SoftcapTableDef extends CapTable {
  name: string;
  attackType: AttackType;
  source?: string;
}

export interface SkillPresetDef {
  name: string;
  multiplier: number;
  approxCap?: number;
  thresholds: number[] | null;
  reductions: number[] | null;
  verified: boolean;
  testCase?: { input: number; expected: number };
  source?: string;
}

export interface SkillExtraCapBand {
  maxMultiplier: number; // この倍率(%)以下の技に適用
  t1: number;
  t2: number;
}

export interface SoftcapData {
  version: number;
  tables: Record<string, SoftcapTableDef>;
  skillPresets: Record<string, SkillPresetDef>;
  capUpLimits: { generic: number; typed: Record<AttackType, number> };
  skillExtraCap: {
    maxMultiplier: number;
    cutBetween: number;
    cutAbove: number;
    scaleWithCapUp: boolean;
    verified: boolean;
    bands: SkillExtraCapBand[];
  };
  specialCaps: Record<SpecialCapKey, { name: string; value: number | null; thresholds: number[] | null; reductions: number[] | null }>;
}

export interface FrameDef {
  id: FrameId;
  name: string;
  group: string;
  mode: 'additive' | 'element' | 'each';
  note?: string;
}

export interface FrameData {
  version: number;
  frames: FrameDef[];
  elementRelation: Record<ElementRelation, number>;
}

export interface LabelDef {
  id: string;
  name: string;
  aliases: string[];
  slot: SlotSpec;
  aura?: AuraSystem;
  unit: '%' | 'flat';
  range: [number, number];
  status: 'confirmed' | 'assumed';
  note?: string;
}

export interface LabelData {
  version: number;
  matchThreshold: number;
  confidenceLevels: { high: number; mid: number };
  header: {
    estimatePlain: string[];
    estimateVs: string[];
    maxHp: string[];
    enhance: string[];
    gridHeading: string[];
    elements: Record<Element, string>;
  };
  labels: LabelDef[];
}

export interface PostCapRule {
  suppAmplifiedBy: Array<'seraphic' | 'other'>;
  suppBeforeSpecialCap: boolean;
}

export interface FormulaData {
  version: number;
  random: { min: number; max: number; step: number };
  defense: { floor: number; floorWithUnique: number; presets: number[] };
  estimate: { def: number; random: number };
  critical: { requiresAdvantage: boolean; defaultCanCrit: Record<AttackType, boolean> };
  postCap: Record<AttackType, PostCapRule>;
  attackDefaults: { caMultiplier: number; skillMultiplier: number };
  marginalStep: number;
}

export interface EngineData {
  softcaps: SoftcapData;
  frames: FrameData;
  labels: LabelData;
  formula: FormulaData;
}

// ---------- 出力 ----------

export interface StageBreakdown {
  frames: Record<FrameId, number>; // 枠ごとの倍率
  multiplier: number; // 技の倍率（奥義は奥義ダメUP込み、アビはアビダメUP込み）
  defEff: number; // 実効防御
  raw: number; // 防御で割る前（乱数1.00・クリティカルなし）
  afterDef: number; // 減衰前
  afterCap: number; // 減衰後（アビの追加減衰込み）
  afterAmp: number; // 与ダメUP後（与ダメ上昇を除く）
  final: number; // 与ダメ上昇・特殊上限まで反映
  capUp: number; // 上限UP合計（小数。0.2 = 20%）
  penetration: number; // 上限突破（小数）
  capTableName: string;
  ampSeraphic: number; // 小数
  ampOther: number; // 小数
  supp: number; // 与ダメ上昇（固定値）
  specialCap: number | null;
}

export interface AttackResult {
  attackId: string;
  name: string;
  type: AttackType;
  perHit: {
    min: number;
    mean: number;
    max: number;
    breakdown: StageBreakdown;
  };
  perTurn?: number; // 通常攻撃のみ（連撃・追撃込み）
  multiattack?: { pTA: number; pDA: number; pSA: number; hits: number };
  echo?: { rate: number; perHitMean: number };
  critChance: number; // 1回以上クリティカルが出る確率
  marginal: Record<FrameId, number>; // 各枠 +10% での伸び率（小数。0.05 = +5%）
  marginalExtra: { capUp: number; amp: number };
  warnings: string[];
}
