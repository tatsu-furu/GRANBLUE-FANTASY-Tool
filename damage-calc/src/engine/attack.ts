import { defaultData, randomValues } from './data';
import { effectiveDefense } from './defense';
import { collectModifiers, slotOf } from './modifiers';
import { multiattackRates } from './multiattack';
import { ampTotals, applyPostCap, type AmpTotals } from './postcap';
import { applySkillExtraCap, resolveCapTable, softCap, type ResolvedCapTable } from './softcap';
import type {
  Assumptions,
  AttackResult,
  AttackSpec,
  AttackType,
  CalcInput,
  ElementRelation,
  EngineData,
  FrameId,
  Modifier,
  PostCapRule,
  RoundingMode,
  StageBreakdown,
} from './types';

const EPS = 1e-6;
/** 浮動小数の誤差で 950 が 949.999… になり 1 少なく切り捨てられるのを防ぐ */
export const floorSafe = (x: number): number => Math.floor(x + EPS);

type ValueOf = (m: Modifier) => number;

/** パネル値は panelValuesIncludeAura が OFF のときだけ加護倍率を掛ける */
export function modifierValue(input: CalcInput, assumptions: Assumptions): ValueOf {
  return (m) =>
    m.source === 'panel' && m.aura && !assumptions.panelValuesIncludeAura
      ? m.value * (1 + input.panel.enhance[m.aura] / 100)
      : m.value;
}

export function isActiveFor(m: Modifier, type: AttackType, relation: ElementRelation, assumptions: Assumptions): boolean {
  if (!m.enabled || !m.appliesTo.includes(type)) return false;
  if (m.condition === 'vsAdvantage' && relation !== 'advantage') {
    return m.kind === 'amp' && !assumptions.advAmpOnlyVsAdvantage;
  }
  return true;
}

export interface FrameResult {
  frames: Record<FrameId, number>;
  product: number;
  unknownFrames: string[];
}

/** 同じ枠の中は加算、枠同士は乗算。枠の一覧は data/frames.json */
export function computeFrames(
  mods: Modifier[],
  type: AttackType,
  relation: ElementRelation,
  data: EngineData,
  valueOf: ValueOf = (m) => m.value,
): FrameResult {
  const atkMods = mods.filter((m) => m.kind === 'atk' && m.enabled && m.appliesTo.includes(type));
  const known = new Set(data.frames.frames.map((f) => f.id));
  const unknownFrames = [...new Set(atkMods.map((m) => m.frame ?? '(未指定)').filter((f) => !known.has(f)))];
  const frames: Record<FrameId, number> = {};
  let product = 1;
  for (const def of data.frames.frames) {
    const ms = atkMods.filter((m) => m.frame === def.id);
    let v: number;
    if (def.mode === 'each') {
      v = ms.reduce((p, m) => p * Math.max(0, 1 + valueOf(m) / 100), 1);
    } else {
      const rel = def.mode === 'element' ? data.frames.elementRelation[relation] / 100 : 0;
      v = Math.max(0, 1 + rel + ms.reduce((s, m) => s + valueOf(m) / 100, 0));
    }
    frames[def.id] = v;
    product *= v;
  }
  return { frames, product, unknownFrames };
}

interface CritOutcome {
  p: number;
  mult: number;
}

/** クリティカル行ごとに独立判定し、発生した行の倍率を加算する（全組み合わせを列挙） */
function critOutcomes(critMods: Modifier[], valueOf: ValueOf): CritOutcome[] {
  let outcomes: CritOutcome[] = [{ p: 1, mult: 1 }];
  for (const m of critMods) {
    const rate = Math.min(1, Math.max(0, (m.critRate ?? 0) / 100));
    const bonus = valueOf(m) / 100;
    outcomes = outcomes.flatMap((o) => [
      { p: o.p * (1 - rate), mult: o.mult },
      { p: o.p * rate, mult: o.mult + bonus },
    ]);
  }
  return outcomes.filter((o) => o.p > 0);
}

export interface PrepareOptions {
  relation: ElementRelation;
  includeBattleBuffs: boolean;
  includeCap: boolean;
  includeAmp: boolean;
  includeSupp: boolean;
  defOverride?: number; // 予測ダメージ用（防御10固定）
  specialCapOverride?: number | null;
  noCrit?: boolean;
  extraMods?: Modifier[]; // 伸び率・逆算で足す仮の補正
}

export interface PreparedAttack {
  attack: AttackSpec;
  type: AttackType;
  opts: PrepareOptions;
  frames: Record<FrameId, number>;
  multiplier: number;
  baseRaw: number; // 基礎攻撃力 × 技倍率 × 枠の積（防御で割る前）
  defEff: number;
  fixed: number;
  cap: ResolvedCapTable;
  capUp: number;
  penetration: number;
  amp: AmpTotals;
  supp: number;
  specialCap: number | null;
  rule: PostCapRule;
  crits: CritOutcome[];
  critChance: number; // 1回以上クリティカルが出る確率
  echoRate: number;
  daPercent: number;
  taPercent: number;
  data: EngineData;
  warnings: string[];
}

export function prepareAttack(input: CalcInput, attack: AttackSpec, data: EngineData, opts: PrepareOptions): PreparedAttack {
  const assumptions = input.assumptions;
  const type = attack.type;
  const valueOf = modifierValue(input, assumptions);
  const all = [...collectModifiers(input, data, { includeBattleBuffs: opts.includeBattleBuffs }), ...(opts.extraMods ?? [])];
  const mods = all.filter((m) => isActiveFor(m, type, opts.relation, assumptions));
  const sum = (kind: Modifier['kind'], pred: (m: Modifier) => boolean = () => true) =>
    mods.filter((m) => m.kind === kind && pred(m)).reduce((s, m) => s + valueOf(m), 0);
  const warnings: string[] = [];

  const { frames, product, unknownFrames } = computeFrames(mods, type, opts.relation, data, valueOf);
  if (unknownFrames.length > 0) warnings.push(`未知の枠（${unknownFrames.join('、')}）の補正は計算に入れていません`);

  let multiplier = attack.multiplier / 100;
  if (type === 'ca') {
    const isWeapon = (m: Modifier) => (m.caDmgGroup ?? (m.source === 'panel' ? 'weapon' : 'buff')) === 'weapon';
    multiplier *= (1 + sum('caDmg', isWeapon) / 100) * (1 + sum('caDmg', (m) => !isWeapon(m)) / 100);
  } else if (type === 'skill') {
    multiplier = (attack.multiplier + sum('skillDmg')) / 100;
  }

  const defEff =
    opts.defOverride ??
    effectiveDefense(
      input.enemy.baseDef,
      { defUp: sum('defUp'), defDown: sum('defDown'), defDownUnique: sum('defDownUnique') },
      data,
    ).value;

  // 武器（パネル）由来の上限UPは種別ごとの上限まで。超えた分は仮定フラグが ON なら上限突破として扱う
  const cap = resolveCapTable(attack, data);
  const panelCapUp = sum('capUp', (m) => m.source === 'panel') / 100;
  const limit = data.softcaps.capUpLimits.weapon[type] / 100;
  const capUp = Math.min(panelCapUp, limit) + sum('capUp', (m) => m.source !== 'panel') / 100;
  const excess = Math.max(0, panelCapUp - limit);
  const penetration = sum('capPen') / 100 + (assumptions.capPenetrationActive ? excess : 0);

  const canCrit = attack.canCrit ?? data.formula.critical.defaultCanCrit[type];
  const critMods = mods.filter((m) => m.kind === 'crit');
  let crits: CritOutcome[] = [{ p: 1, mult: 1 }];
  let critChance = 0;
  if (!opts.noCrit && canCrit && critMods.length > 0) {
    if (data.formula.critical.requiresAdvantage && opts.relation !== 'advantage') {
      warnings.push('クリティカルは有利属性のときだけ発生するため、今の属性相性では計算していません');
    } else {
      crits = critOutcomes(critMods, valueOf);
      critChance = 1 - critMods.reduce((p, m) => p * (1 - Math.min(1, Math.max(0, (m.critRate ?? 0) / 100))), 1);
    }
  }

  if (input.character.baseAtk <= 0) warnings.push('基礎攻撃力が未入力です');
  if (opts.includeCap && !cap.table) warnings.push(`${cap.name}: 減衰表が無いため減衰なしで計算しています`);
  const extraCfg = data.softcaps.skillExtraCap;
  if (opts.includeCap && type === 'skill' && attack.multiplier <= extraCfg.maxMultiplier && extraCfg.bands.length === 0) {
    warnings.push(`倍率${extraCfg.maxMultiplier}%以下のアビの追加減衰は、倍率帯の表が未入力のため計算していません`);
  }

  return {
    attack,
    type,
    opts,
    frames,
    multiplier,
    baseRaw: input.character.baseAtk * multiplier * product,
    defEff,
    fixed: type === 'ca' ? attack.fixedDamage ?? 0 : 0,
    cap,
    capUp,
    penetration,
    amp: ampTotals(mods, valueOf, assumptions),
    supp: sum('supp'),
    specialCap:
      opts.specialCapOverride !== undefined ? opts.specialCapOverride : data.softcaps.specialCaps[input.enemy.specialCap]?.value ?? null,
    rule: data.formula.postCap[type],
    crits,
    critChance,
    echoRate: type === 'normal' ? sum('echo') / 100 : 0,
    daPercent: input.character.baseDA + sum('da'),
    taPercent: input.character.baseTA + sum('ta'),
    data,
    warnings,
  };
}

export interface OutcomeStages {
  afterDef: number;
  afterCap: number;
  afterAmp: number;
  final: number;
  hitSpecialCap: boolean;
}

/** 乱数 r・クリティカル倍率 critMult のときの1ヒット */
export function evaluateOutcome(prep: PreparedAttack, r: number, critMult: number, rounding: RoundingMode): OutcomeStages {
  const rnd = rounding === 'each' ? floorSafe : (x: number) => x;
  const { opts } = prep;
  const afterDef = rnd((prep.baseRaw * r * critMult) / prep.defEff + prep.fixed);
  let afterCap = afterDef;
  if (opts.includeCap) {
    if (prep.cap.table) afterCap = softCap(afterCap, prep.cap.table, prep.capUp, prep.penetration);
    if (prep.type === 'skill') {
      afterCap = applySkillExtraCap(afterCap, prep.attack.multiplier, prep.capUp, prep.data.softcaps.skillExtraCap).value;
    }
  }
  afterCap = rnd(afterCap);
  const amp = opts.includeAmp ? prep.amp : { seraphic: 0, other: 0 };
  const post = applyPostCap(afterCap, amp, opts.includeSupp ? prep.supp : 0, prep.specialCap, prep.rule, rnd);
  const final = rounding === 'none' ? post.final : floorSafe(post.final);
  return { afterDef, afterCap, afterAmp: post.afterAmp, final, hitSpecialCap: post.hitSpecialCap };
}

interface Aggregate {
  mean: number;
  min: number;
  max: number;
  echoMean: number;
  hitSpecialCap: boolean;
}

/** 乱数11通り × クリティカルの組み合わせをすべて減衰に通して平均する */
function aggregate(prep: PreparedAttack, assumptions: Assumptions): Aggregate {
  const rs = randomValues(prep.data);
  let mean = 0;
  let echo = 0;
  let min = Infinity;
  let max = -Infinity;
  let hitSpecialCap = false;
  for (const r of rs) {
    for (const c of prep.crits) {
      const o = evaluateOutcome(prep, r, c.mult, assumptions.roundingMode);
      const w = c.p / rs.length;
      mean += w * o.final;
      const echoBase = assumptions.echoBase === 'afterCap' ? o.afterCap : assumptions.echoBase === 'afterAmp' ? o.afterAmp : o.final;
      echo += w * echoBase;
      min = Math.min(min, o.final);
      max = Math.max(max, o.final);
      hitSpecialCap ||= o.hitSpecialCap;
    }
  }
  return { mean, min, max, echoMean: prep.echoRate * echo, hitSpecialCap };
}

function metricOf(prep: PreparedAttack, agg: Aggregate): number {
  if (prep.type !== 'normal') return agg.mean;
  return multiattackRates(prep.daPercent, prep.taPercent).hits * (agg.mean + agg.echoMean);
}

function marginalMods(type: AttackType, step: number, frame: FrameId): Modifier {
  return { id: '__marginal', label: '+10%', source: 'buff', kind: 'atk', frame, appliesTo: [type], value: step, enabled: true };
}

export function calculateAttack(input: CalcInput, attack: AttackSpec, data: EngineData, opts: PrepareOptions): AttackResult {
  const prep = prepareAttack(input, attack, data, opts);
  const agg = aggregate(prep, input.assumptions);
  const nominal = evaluateOutcome(prep, 1, 1, input.assumptions.roundingMode);
  const metric = metricOf(prep, agg);

  const step = data.formula.marginalStep;
  const growth = (extra: Modifier) => {
    if (metric <= 0) return 0;
    const p = prepareAttack(input, attack, data, { ...opts, extraMods: [...(opts.extraMods ?? []), extra] });
    return metricOf(p, aggregate(p, input.assumptions)) / metric - 1;
  };
  const marginal: Record<FrameId, number> = {};
  for (const f of data.frames.frames) marginal[f.id] = growth(marginalMods(attack.type, step, f.id));
  const marginalExtra = {
    capUp: growth({ id: '__m_cap', label: '上限UP', source: 'buff', kind: 'capUp', appliesTo: [attack.type], value: step, enabled: true }),
    amp: growth({ id: '__m_amp', label: '与ダメUP', source: 'buff', kind: 'amp', appliesTo: [attack.type], value: step, enabled: true }),
  };

  const breakdown: StageBreakdown = {
    frames: prep.frames,
    multiplier: prep.multiplier,
    defEff: prep.defEff,
    raw: prep.baseRaw,
    afterDef: nominal.afterDef,
    afterCap: nominal.afterCap,
    afterAmp: nominal.afterAmp,
    final: nominal.final,
    capUp: prep.capUp,
    penetration: prep.penetration,
    capTableName: prep.cap.name,
    ampSeraphic: prep.amp.seraphic,
    ampOther: prep.amp.other,
    supp: prep.supp,
    specialCap: prep.specialCap,
  };

  const warnings = [...prep.warnings];
  if (agg.hitSpecialCap) warnings.push('特殊上限に達しています');
  const result: AttackResult = {
    attackId: attack.id,
    name: attack.name,
    type: attack.type,
    perHit: { min: agg.min, mean: agg.mean, max: agg.max, breakdown },
    critChance: prep.critChance,
    marginal,
    marginalExtra,
    warnings,
  };
  if (attack.type === 'normal') {
    const ma = multiattackRates(prep.daPercent, prep.taPercent);
    result.multiattack = ma;
    result.perTurn = ma.hits * (agg.mean + agg.echoMean);
    if (prep.echoRate > 0) result.echo = { rate: prep.echoRate, perHitMean: agg.echoMean };
  }
  return result;
}

/** 入力一式から、有効な攻撃すべての結果を出す */
export function calculate(input: CalcInput, data: EngineData = defaultData): AttackResult[] {
  const opts: PrepareOptions = {
    relation: input.character.elementRelation,
    includeBattleBuffs: true,
    includeCap: true,
    includeAmp: true,
    includeSupp: true,
  };
  return input.attacks.filter((a) => a.enabled !== false).map((a) => calculateAttack(input, a, data, opts));
}

/** 入力全体についての注意（攻撃ごとの警告とは別） */
export function inputWarnings(input: CalcInput, data: EngineData = defaultData): string[] {
  const out: string[] = [];
  const unclassified = input.panel.skills.filter((s) => !s.ignored && slotOf(s, data.labels).kind === 'unclassified');
  if (unclassified.length > 0) {
    out.push(`未分類の項目が ${unclassified.length} 件あります（${unclassified.map((s) => s.labelRaw).join('、')}）。枠を割り当てるまで計算に入りません`);
  }
  return out;
}
