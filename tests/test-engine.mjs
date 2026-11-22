// 計算（kosenjou-schedule.js）を、ブラウザなしで確かめるテスト。
//   ・同じ入力は、何回やっても、時計が違っても、同じ答えになる（打ち切りが「時間」でなく「枝の数」なので）
//   ・画面が使う計画（実際の肉・素材 / 十分あるとき / 必要な肉の計画）は、整数の検算を、すべて通る
//   ・検算（verifyPlan）が、守っていない計画を、ちゃんと見つける
//   ・必要な肉の計画は、肉の使用が「必要な肉」と同じで、目標に届いている
import { loadEngine } from './engine.mjs';

let fails = 0, total = 0;
const ok = (cond, msg, extra = '') => { total++; if (!cond) fails++; console.log(`${cond ? 'OK  ' : 'NG  '} ${msg}${!cond && extra ? '\n      ' + String(extra).slice(0, 600) : ''}`); };

const E = loadEngine();
const { PHASES } = E;

// ── 乱数（毎回、同じ列） ──
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const FULL = { h90: 90, h95: 120, h100: 150, h150: 180, h200: 300, h250: 900 };
const randomTimes = (r) => ({ h90: 40 + Math.floor(r() * 120), h95: 60 + Math.floor(r() * 160), h100: 80 + Math.floor(r() * 200), h150: 60 + Math.floor(r() * 400), h200: 150 + Math.floor(r() * 700), h250: 400 + Math.floor(r() * 1800) });
const pick = (r, list) => list[Math.floor(r() * list.length)];

/** ランダムな問題を作る */
function randomCase(r) {
  let times = randomTimes(r);
  if (r() < 0.25) { const keep = pick(r, ['h150', 'h200', 'h250']); times = { [keep]: times[keep] }; }
  if (r() < 0.15) delete times.h250;
  const hours = { q: null };
  for (const id of ['d1', 'd2', 'd3', 'd4']) hours[id] = r() < 0.7 ? null : pick(r, [0, 0, 2, 3, 5, 8]);
  return {
    times,
    need: Math.round((2 + r() * 11) * 1e9),
    stock: r() < 0.25 ? Infinity : Math.floor(r() * 60000),
    mat250: r() < 0.5 ? null : Math.floor(r() * 3000),
    hoursOpt: { includeQ: r() < 0.3, hours },
    priority: r() < 0.5 ? 'time' : 'meat',
  };
}
const run = (E_, c) => E_.scheduleScenario(c.priority, { diffs: E_.planDiffsFrom(c.times), stock: c.stock, mat250: c.mat250, need: c.need, hoursOpt: c.hoursOpt });
const json = (x) => JSON.stringify(x, (k, v) => (v === Infinity ? 'Infinity' : v));

// ── 1. 同じ入力は、何回やっても、時計が違っても、同じ答え ──
{
  const r = rng(11);
  const cases = Array.from({ length: 12 }, () => randomCase(r));
  cases.push({ times: FULL, need: 6e9, stock: 40000, mat250: null, hoursOpt: { includeQ: false, hours: {} }, priority: 'time' });
  cases.push({ times: { ...FULL, h150: 40 }, need: 1e10, stock: 40000, mat250: 900, hoursOpt: { includeQ: true, hours: {} }, priority: 'meat' });
  let same10 = 0, sameFrozen = 0, sameFast = 0, deviceCases = 0;
  for (const c of cases) {
    const first = json(run(E, c));
    let all = true;
    for (let i = 0; i < 9; i++) if (json(run(E, c)) !== first) all = false;      // 同じ入力を、あわせて10回
    if (all) same10++;
    const frozen = loadEngine({ performance: { now: () => 0 } });                 // 時計が止まっている
    if (json(run(frozen, c)) === first) sameFrozen++;
    let t = 0;
    const slow = loadEngine({ performance: { now: () => (t += 1) } });            // 呼ぶたびに 1ミリ秒 進む時計（遅い端末の、ひとつの見立て）
    if (json(run(slow, c)) === first) sameFast++;
    deviceCases++;
  }
  ok(same10 === cases.length, `同じ入力を10回計算して、結果が完全に一致する（${same10}/${cases.length}件）`);
  ok(sameFrozen === deviceCases, `時計が止まっていても、結果が一致する（${sameFrozen}/${deviceCases}件）`);
  ok(sameFast === deviceCases, `時計が進んでも（1回呼ぶごとに 1ms）、結果が一致する（${sameFast}/${deviceCases}件）`);
}

// ── 2. 画面が使う計画は、整数の検算を、すべて通る（検算は、この中で、別に書いた） ──
/** 独立した検算：計画の全部の制約を、整数で確かめる。問題があれば、理由の文字列を返す */
function independentCheck(plan, c, diffsP, phases) {
  let meat = 0, mat = 0, sumC = 0;
  for (const ph of phases) {
    let sec = 0;
    for (const d of diffsP) {
      const n = plan.runs[ph.id][d.id];
      if (!Number.isInteger(n) || n < 0) return `回数が整数でない ${ph.id}/${d.id}=${n}`;
      if (!n) continue;
      if (!(ph.hours > 0)) return `時間 0 の日に回数 ${ph.id}/${d.id}`;
      if (d.tier > ph.maxTier) return `解放前の難易度 ${ph.id}/${d.id}`;
      if (d.only && !d.only.includes(ph.id)) return `使う日の指定に反する ${ph.id}/${d.id}`;
      sec += n * d.time; sumC += n * d.contrib;
      if (d.is250) mat += n * d.chunks; else meat += n * d.chunks;
    }
    if (sec > ph.hours * 3600 + 1e-6) return `時間超過 ${ph.id} ${sec} > ${ph.hours * 3600}`;
  }
  if (c.mat250 != null && mat > c.mat250) return `素材超過 ${mat} > ${c.mat250}`;
  const conv = c.mat250 == null ? 0 : 2 * Math.min(500, c.mat250 - mat);
  if (c.stock !== Infinity && meat > c.stock + conv) return `肉超過 ${meat} > ${c.stock} + ${conv}`;
  if (plan.total !== sumC) return `合計が合わない ${plan.total} ≠ ${sumC}`;
  return null;
}
{
  const r = rng(2024);
  let nPlans = 0, bad = [], nReq = 0, reqBad = [], hoursBad = [];
  const N = 150;
  for (let i = 0; i < N; i++) {
    const c = randomCase(r);
    const sc = run(E, c);
    const spec = sc.spec;
    const A = sc.solved.actual, U = sc.solved.unlimited;
    const phasesAt = (h) => PHASES.map((ph, k) => ({ id: ph.id, maxTier: ph.maxTier, hours: spec[k].fixed ? spec[k].hours : h }));
    const list = [['実際', A.plan, { ...c }, phasesAt(sc.solved.hasAuto ? A.hours : 0)], ['十分', U.plan, { ...c, stock: Infinity, mat250: null }, phasesAt(sc.solved.hasAuto ? U.hours : 0)]];
    if (sc.req) list.push(['必要な肉', sc.req.plan, { ...c, stock: sc.req.meat, mat250: null }, phasesAt(sc.req.hours)]);
    for (const [name, plan, cc, phases] of list) {
      nPlans++;
      const why = independentCheck(plan, cc, sc.diffsP, phases);
      if (why) bad.push(`#${i} ${name}: ${why}`);
      const v = E.verifyPlan(plan, { stock: cc.stock, mat250: cc.mat250, phases, diffs: sc.diffsP });
      if (!v.ok) bad.push(`#${i} ${name}: verifyPlan が通らない ${v.errors.join(' / ')}`);
      if (plan.invalid) bad.push(`#${i} ${name}: invalid が立っている`);
    }
    if (sc.req) {
      nReq++;
      const use = E.scheduleUsage(sc.req.plan, sc.diffsP, 0, null);
      if (use.meat !== sc.req.meat) reqBad.push(`#${i} 肉の使用 ${use.meat} ≠ 必要な肉 ${sc.req.meat}`);
      if (use.mat !== sc.req.mat) reqBad.push(`#${i} 素材の使用 ${use.mat} ≠ ${sc.req.mat}`);
      if (sc.req.plan.total < c.need) reqBad.push(`#${i} 必要な肉の計画が、目標に届いていない ${sc.req.plan.total} < ${c.need}`);
      if (sc.req.hours !== U.hours) hoursBad.push(`#${i} 時間 ${sc.req.hours} ≠ ${U.hours}`);
    }
  }
  ok(bad.length === 0, `画面が使う計画は、すべて検算を通る（${nPlans}個の計画・${N}問）`, bad.slice(0, 5).join('\n      '));
  ok(reqBad.length === 0, `必要な肉の計画は、肉・素材の使用が「必要な肉・素材」と同じで、目標に届いている（${nReq}問）`, reqBad.slice(0, 5).join('\n      '));
  ok(hoursBad.length === 0, '必要な肉の計画の毎日の時間は、肉が十分あるときの時間と同じ', hoursBad.slice(0, 5).join('\n      '));
}

// ── 3. 無制限は、10⁹ ではなく、制約なし ──
{
  const r = rng(5);
  let same = 0, n = 0;
  for (let i = 0; i < 20; i++) {
    const c = randomCase(r); c.stock = Infinity; c.mat250 = null;
    const a = json(run(E, c));
    const b = json(run(E, { ...c, stock: null }));                                // null も、無制限
    n++; if (a === b) same++;
  }
  ok(same === n, `肉が null でも Infinity でも、同じ結果（無制限）（${same}/${n}件）`);
  const sc = run(E, { times: FULL, need: 6e9, stock: Infinity, mat250: null, hoursOpt: { includeQ: false, hours: {} }, priority: 'time' });
  ok(sc.solved.actual.reachable && sc.solved.actual.hours === sc.solved.unlimited.hours, '肉が無制限のとき、「実際」と「十分あるとき」が一致する');
}

// ── 4. 検算（verifyPlan）は、守っていない計画を見つける ──
{
  const diffs = E.planDiffsFrom(FULL);
  const phases = PHASES.map((ph) => ({ id: ph.id, maxTier: ph.maxTier, hours: ph.id === 'd3' ? 2 : 0 }));
  const zero = () => { const runs = {}; PHASES.forEach((ph) => { runs[ph.id] = {}; diffs.forEach((d) => { runs[ph.id][d.id] = 0; }); }); return runs; };
  const mk = (edit) => { const runs = zero(); edit(runs); let total = 0; PHASES.forEach((ph) => diffs.forEach((d) => { total += runs[ph.id][d.id] * d.contrib; })); return { runs, total }; };
  const good = mk((r) => { r.d3.h250 = 8; });                                      // 900秒 × 8 = 2時間
  ok(E.verifyPlan(good, { stock: Infinity, mat250: null, phases, diffs }).ok, '検算：守っている計画は、通る');
  ok(!E.verifyPlan(mk((r) => { r.d3.h250 = 9; }), { stock: Infinity, mat250: null, phases, diffs }).ok, '検算：時間を超えた計画は、通らない');
  ok(!E.verifyPlan(mk((r) => { r.d3.h200 = 1.5; }), { stock: Infinity, mat250: null, phases, diffs }).ok, '検算：回数が整数でない計画は、通らない');
  ok(!E.verifyPlan(mk((r) => { r.d3.h200 = -1; }), { stock: Infinity, mat250: null, phases, diffs }).ok, '検算：回数が負の計画は、通らない');
  ok(!E.verifyPlan(mk((r) => { r.d1.h200 = 1; }), { stock: Infinity, mat250: null, phases: PHASES.map((ph) => ({ id: ph.id, maxTier: ph.maxTier, hours: 5 })), diffs }).ok, '検算：まだ解放されていない難易度（本戦1日目の 200HELL）は、通らない');
  ok(!E.verifyPlan(mk((r) => { r.d2.h150 = 1; }), { stock: Infinity, mat250: null, phases, diffs }).ok, '検算：時間が 0 の日に回数がある計画は、通らない');
  const meat = mk((r) => { r.d3.h200 = 20; });                                     // 肉 400
  ok(E.verifyPlan(meat, { stock: 400, mat250: null, phases: PHASES.map((ph) => ({ id: ph.id, maxTier: ph.maxTier, hours: ph.id === 'd3' ? 9 : 0 })), diffs }).ok, '検算：肉がちょうどの計画は、通る');
  ok(!E.verifyPlan(meat, { stock: 399, mat250: null, phases: PHASES.map((ph) => ({ id: ph.id, maxTier: ph.maxTier, hours: ph.id === 'd3' ? 9 : 0 })), diffs }).ok, '検算：肉が1個足りない計画は、通らない');
  const withMat = mk((r) => { r.d3.h200 = 22; });                                  // 肉 440、素材は使わない → 素材 100 個で、肉 200 に変換できる
  const ph9 = PHASES.map((ph) => ({ id: ph.id, maxTier: ph.maxTier, hours: ph.id === 'd3' ? 9 : 0 }));
  ok(E.verifyPlan(withMat, { stock: 240, mat250: 100, phases: ph9, diffs }).ok, '検算：余った素材を肉に変換すれば足りる計画は、通る（肉 240 + 素材 100 × 2 = 440）');
  ok(!E.verifyPlan(withMat, { stock: 239, mat250: 100, phases: ph9, diffs }).ok, '検算：変換しても、肉が1個足りない計画は、通らない');
  const tooMuchMat = mk((r) => { r.d3.h250 = 6; });                                // 素材 120
  ok(!E.verifyPlan(tooMuchMat, { stock: Infinity, mat250: 100, phases, diffs }).ok, '検算：素材を超えた計画は、通らない');
  const wrongTotal = mk((r) => { r.d3.h250 = 8; }); wrongTotal.total += 1;
  ok(!E.verifyPlan(wrongTotal, { stock: Infinity, mat250: null, phases, diffs }).ok, '検算：合計が合わない計画は、通らない');
}

console.log(`\n${fails === 0 ? `全部 OK（${total}件）` : `${fails} 件 NG / ${total}件`}`);
process.exit(fails ? 1 : 0);
