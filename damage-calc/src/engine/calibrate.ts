// キャリブレーション: パネルの予測ダメージ（防御10・通常攻撃1回・戦闘中バフなし）を正解データにして、
// 式の実装と仕様の仮定を検証する。
import { evaluateOutcome, prepareAttack } from './attack';
import { defaultData } from './data';
import type {
  Assumptions,
  AttackSpec,
  BooleanAssumptionKey,
  CalcInput,
  Element,
  EngineData,
  Modifier,
  RoundingMode,
} from './types';

export interface CalibrationTarget {
  plain: number;
  vsElement?: { element: Element; value: number } | undefined;
}

export type UnknownKey = 'baseAtk' | 'elementAura' | 'capUpNormal';

export interface UnknownDef {
  key: UnknownKey;
  label: string;
  unit: '' | '%';
  lo: number;
  hi: number;
  expandHi: boolean; // f(hi) が目標に届かなければ hi を倍々に広げる
}

export const UNKNOWNS: Record<UnknownKey, UnknownDef> = {
  baseAtk: { key: 'baseAtk', label: '基礎攻撃力', unit: '', lo: 0, hi: 1_000_000, expandHi: true },
  elementAura: { key: 'elementAura', label: '属性枠の追加分（属性加護など）', unit: '%', lo: -90, hi: 5_000, expandHi: false },
  capUpNormal: { key: 'capUpNormal', label: '通常攻撃の上限UP（パネルに加える分）', unit: '%', lo: -50, hi: 1_000, expandHi: false },
};

// 6.2 の仮説フラグ（advAmpIsSeraphic は天司系の与ダメUPが複数あるときしか効かないので探索しない）
export const SEARCH_FLAGS: readonly BooleanAssumptionKey[] = [
  'panelValuesIncludeAura',
  'estimateIncludesSoftCap',
  'estimateIncludesAmp',
  'advAmpOnlyVsAdvantage',
  'estimateIncludesSupp',
  'plainEstimateIsNeutral',
  'capPenetrationActive',
];
export const ROUNDING_MODES: readonly RoundingMode[] = ['final', 'each', 'none'];

const ADVANTAGE: Record<Element, Element> = {
  fire: 'wind',
  wind: 'earth',
  earth: 'water',
  water: 'fire',
  light: 'dark',
  dark: 'light',
};

/** その属性が有利を取れる属性（「対○属性予測ダメージ」の○） */
export function advantageTarget(element: Element): Element {
  return ADVANTAGE[element];
}

const ESTIMATE_ATTACK: AttackSpec = {
  id: 'estimate',
  name: '予測ダメージ',
  type: 'normal',
  multiplier: 100,
  capTableKey: 'normal',
  canCrit: false,
};

/** パネルの予測ダメージを再現する。which = plain は無印、vs は「対○属性」（有利） */
export function estimateDamage(
  input: CalcInput,
  which: 'plain' | 'vs',
  data: EngineData = defaultData,
  extraMods: Modifier[] = [],
): number {
  const a = input.assumptions;
  const relation = which === 'vs' ? 'advantage' : a.plainEstimateIsNeutral ? 'neutral' : input.character.elementRelation;
  const prep = prepareAttack(input, ESTIMATE_ATTACK, data, {
    relation,
    includeBattleBuffs: false,
    includeCap: a.estimateIncludesSoftCap,
    includeAmp: a.estimateIncludesAmp,
    includeSupp: a.estimateIncludesSupp,
    defOverride: data.formula.estimate.def,
    specialCapOverride: null,
    noCrit: true,
    extraMods,
  });
  return evaluateOutcome(prep, data.formula.estimate.random, 1, a.roundingMode).final;
}

function applyUnknown(input: CalcInput, key: UnknownKey, x: number): { input: CalcInput; extraMods: Modifier[] } {
  switch (key) {
    case 'baseAtk':
      return { input: { ...input, character: { ...input.character, baseAtk: x } }, extraMods: [] };
    case 'elementAura':
      return {
        input,
        extraMods: [{ id: '__unknown', label: '未知数', source: 'manual', kind: 'atk', frame: 'element', appliesTo: ['normal'], value: x, enabled: true }],
      };
    case 'capUpNormal':
      return {
        input,
        extraMods: [{ id: '__unknown', label: '未知数', source: 'manual', kind: 'capUp', appliesTo: ['normal'], value: x, enabled: true }],
      };
  }
}

function estimateWith(input: CalcInput, key: UnknownKey, x: number, which: 'plain' | 'vs', data: EngineData): number {
  const u = applyUnknown(input, key, x);
  return estimateDamage(u.input, which, data, u.extraMods);
}

/** 単調非減少な f について f(x) ≥ target となる最小の x を二分法で探す。範囲内に無ければ null */
function bisect(f: (x: number) => number, target: number, def: UnknownDef): number | null {
  let lo = def.lo;
  let hi = def.hi;
  if (f(lo) > target) return null;
  if (def.expandHi) {
    for (let i = 0; i < 40 && f(hi) < target; i++) {
      lo = hi;
      hi *= 2;
    }
  }
  if (f(hi) < target) return null;
  for (let i = 0; i < 200 && hi - lo > 1e-9 * Math.max(1, Math.abs(hi)); i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < target) lo = mid;
    else hi = mid;
  }
  return hi;
}

export interface CalibrationResult {
  assumptions: Assumptions;
  unknownKey: UnknownKey | null;
  solvedValue: number | null;
  plainPredicted: number | null;
  plainError: number | null; // 予測 / 実際 − 1
  vsPredicted: number | null;
  vsError: number | null;
  message?: string;
}

const relErr = (pred: number, actual: number) => (actual === 0 ? null : pred / actual - 1);

/** 順算: 入力の基礎攻撃力で予測ダメージ2つを再現できるか */
export function forwardCheck(input: CalcInput, target: CalibrationTarget, data: EngineData = defaultData): CalibrationResult {
  const plainPredicted = estimateDamage(input, 'plain', data);
  const vsPredicted = target.vsElement ? estimateDamage(input, 'vs', data) : null;
  return {
    assumptions: input.assumptions,
    unknownKey: null,
    solvedValue: null,
    plainPredicted,
    plainError: relErr(plainPredicted, target.plain),
    vsPredicted,
    vsError: vsPredicted !== null && target.vsElement ? relErr(vsPredicted, target.vsElement.value) : null,
  };
}

/** 逆算: 未知数1つを無印の予測ダメージに合わせて求め、その値で対属性の予測ダメージを答え合わせする */
export function calibrate(
  input: CalcInput,
  target: CalibrationTarget,
  unknownKey: UnknownKey,
  data: EngineData = defaultData,
): CalibrationResult {
  const empty: CalibrationResult = {
    assumptions: input.assumptions,
    unknownKey,
    solvedValue: null,
    plainPredicted: null,
    plainError: null,
    vsPredicted: null,
    vsError: null,
  };
  if (!(target.plain > 0)) return { ...empty, message: '予測ダメージ（無印）が未入力です' };
  if (unknownKey !== 'baseAtk' && !(input.character.baseAtk > 0)) {
    return { ...empty, message: '基礎攻撃力を入れてから逆算してください' };
  }
  const def = UNKNOWNS[unknownKey];
  const x = bisect((v) => estimateWith(input, unknownKey, v, 'plain', data), target.plain, def);
  if (x === null) {
    return { ...empty, message: `${def.label}をどう変えても無印の予測ダメージに届きません（この仮定では再現できない）` };
  }
  const plainPredicted = estimateWith(input, unknownKey, x, 'plain', data);
  const vsPredicted = target.vsElement ? estimateWith(input, unknownKey, x, 'vs', data) : null;
  return {
    ...empty,
    solvedValue: x,
    plainPredicted,
    plainError: relErr(plainPredicted, target.plain),
    vsPredicted,
    vsError: vsPredicted !== null && target.vsElement ? relErr(vsPredicted, target.vsElement.value) : null,
  };
}

/** 仮説フラグ × 丸めの全組み合わせ */
export function hypothesisSpace(base: Assumptions, flags: readonly BooleanAssumptionKey[] = SEARCH_FLAGS): Assumptions[] {
  const out: Assumptions[] = [];
  for (let bits = 0; bits < 2 ** flags.length; bits++) {
    for (const roundingMode of ROUNDING_MODES) {
      const a: Assumptions = { ...base, roundingMode };
      flags.forEach((f, i) => {
        a[f] = ((bits >> i) & 1) === 0; // bits = 0 がすべて ON
      });
      out.push(a);
    }
  }
  return out;
}

const absOrInf = (x: number | null) => (x === null ? Infinity : Math.abs(x));

/** 仮説探索: 全組み合わせで逆算し、対属性側の誤差が小さい順に並べる */
export function searchHypotheses(
  input: CalcInput,
  target: CalibrationTarget,
  unknownKey: UnknownKey = 'baseAtk',
  data: EngineData = defaultData,
): CalibrationResult[] {
  return hypothesisSpace(input.assumptions)
    .map((assumptions) => calibrate({ ...input, assumptions }, target, unknownKey, data))
    .sort((a, b) => absOrInf(a.vsError) - absOrInf(b.vsError) || absOrInf(a.plainError) - absOrInf(b.plainError));
}

export interface CalibrationSample {
  id: string;
  name: string;
  input: CalcInput;
  target: CalibrationTarget;
}

export interface MultiHypothesisResult {
  assumptions: Assumptions;
  perSample: CalibrationResult[];
  rmsError: number | null; // 対属性誤差の二乗平均平方根。1件でも逆算できなければ null
}

/** 複数スクショ: サンプルごとに逆算し、対属性誤差の二乗平均が最小になる仮説を探す */
export function searchHypothesesMulti(
  samples: CalibrationSample[],
  unknownKey: UnknownKey = 'baseAtk',
  data: EngineData = defaultData,
): MultiHypothesisResult[] {
  const first = samples[0];
  if (!first) return [];
  return hypothesisSpace(first.input.assumptions)
    .map((assumptions) => {
      const perSample = samples.map((s) => calibrate({ ...s.input, assumptions }, s.target, unknownKey, data));
      const errs = perSample.map((r) => r.vsError);
      const rmsError = errs.every((e): e is number => e !== null)
        ? Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / errs.length)
        : null;
      return { assumptions, perSample, rmsError };
    })
    .sort((a, b) => absOrInf(a.rmsError) - absOrInf(b.rmsError));
}
