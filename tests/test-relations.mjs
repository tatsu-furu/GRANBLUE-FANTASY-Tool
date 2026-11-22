// 計算の「関係」を、乱数（毎回同じ列）で作った入力で確かめるテスト（ブラウザなし）。
// 正しい答えを知らなくても、入力を少し変えたとき、答えが、決まった向きに動くことは、確かめられる。
//   1. 肉が増えるほど、取れる貢献度は、減らない
//   2. 目標が高いほど、毎日の時間と、必要な通常肉は、減らない
//   3. ○の日を×にすると、残りの自動の日の時間は、減らない
//   4. 欲しい極星器の本数が増えるほど、毎日の時間は、減らない。毎日の時間を同じにすると、必要な通常肉も、減らない
//   5. 毎日の時間を増やすほど、必要な通常肉は、増えない
import vm from 'node:vm';
import { loadEngine, read } from './engine.mjs';

let fails = 0, total = 0;
const ok = (cond, msg, extra = '') => { total++; if (!cond) fails++; console.log(`${cond ? 'OK  ' : 'NG  '} ${msg}${!cond && extra ? '\n      ' + String(extra).slice(0, 900) : ''}`); };

const E = loadEngine({ scripts: ['kosenjou-plan-core.js'] });
const th = vm.createContext({ window: {} });
vm.runInContext(read('kosenjou-trehun.js'), th, { filename: 'kosenjou-trehun.js' });
const DEF = { diff: 'h200', boxBase: 4, itemRate: 8, trehun: 0, tears: 0, tearsOdds: 0, weathercock: 3, essel: 0, character: 0, coexist: false, richard: false, minic: false, weapon: 0, dbee: false, mainStone: 0, friendStone: 0, artifact: 0, precious: false, preciousFrame: 3 };
const sp = E.PlanCore.starProbs({ perDiff: th.window.TrehunPanel.perDiff(DEF, E.HELL_DIFFS.map((d) => d.id)) }, E.HELL_DIFFS);

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pick = (r, list) => list[Math.floor(r() * list.length)];

/** 現実的な討伐タイム（秒）：効率が、高い難易度ほど高い（200HELL > 150HELL > 100HELL）の範囲で、ばらつかせる */
function times(r) {
  const k = 0.7 + r() * 0.8;                                                           // 全体の速さ
  return { h90: Math.round(70 * k), h95: Math.round(110 * k), h100: Math.round(150 * k), h150: Math.round((110 + r() * 160) * k), h200: Math.round((240 + r() * 300) * k), h250: Math.round((700 + r() * 900) * k) };
}
const scen = (pr, o) => E.scheduleScenario(pr, { diffs: E.planDiffsFrom(o.times), stock: o.stock ?? Infinity, mat250: o.mat250 ?? null, need: o.need, hoursOpt: o.hoursOpt || { includeQ: false, hours: {} }, star: o.star || null });

const N = 40;   // 各関係で、乱数の入力を 40通り（あわせて 200通り）

// 1. 肉が増えるほど、取れる貢献度は、減らない（時間が決まっているとき）
{
  const r = rng(101); const bad = [];
  for (let i = 0; i < N; i++) {
    const t = times(r), pr = pick(r, ['time', 'meat']), h = pick(r, [3, 5, 8]);
    const hours = { q: null, d1: h, d2: h, d3: h, d4: h };
    const diffsP = E.allowedDiffs(E.planDiffsFrom(t), pr);
    const spec = E.scheduleHoursSpec(diffsP, { includeQ: false, hours });
    const phases = E.PHASES.map((ph, k) => ({ id: ph.id, maxTier: ph.maxTier, hours: spec[k].fixed ? spec[k].hours : 0 }));
    const stocks = [500, 1500, 4000, 9000, 20000].map((x) => x + Math.floor(r() * 300));
    let prev = null;
    for (const s of stocks) {
      const p = E.planSchedule({ stock: s, mat250: null, phases, diffs: diffsP });
      if (prev && p.total < prev.total - 1e-6) bad.push({ i, t, pr, h, from: prev.s, to: s, was: prev.total, now: p.total });
      prev = { s, total: p.total };
    }
  }
  ok(bad.length === 0, `肉が増えるほど、取れる貢献度は、減らない（${N}通り × 5段階）`, JSON.stringify(bad.slice(0, 2)));
}

// 2. 目標が高いほど、毎日の時間と、必要な通常肉は、減らない
{
  const r = rng(202); const bad = [];
  for (let i = 0; i < N; i++) {
    const t = times(r), pr = pick(r, ['time', 'meat']);
    const needs = [2e9, 3.5e9, 5e9, 7e9, 9e9];
    let prev = null;
    for (const need of needs) {
      const sc = scen(pr, { times: t, need });
      if (!sc.solved.unlimited.reachable) { prev = null; continue; }
      const cur = { need, hours: sc.solved.unlimited.hours, meat: sc.req.meat };
      if (prev && (cur.hours < prev.hours - 1e-9 || cur.meat < prev.meat - 1e-9)) bad.push({ i, t, pr, prev, cur });
      prev = cur;
    }
  }
  ok(bad.length === 0, `目標が高いほど、毎日の時間と、必要な通常肉は、減らない（${N}通り × 5段階）`, JSON.stringify(bad.slice(0, 2)));
}

// 3. ○の日を×にすると、残りの自動の日の時間は、減らない（必要な肉も）
{
  const r = rng(303); const bad = [];
  for (let i = 0; i < N; i++) {
    const t = times(r), pr = pick(r, ['time', 'meat']), need = pick(r, [3e9, 5e9]);
    const day = pick(r, ['d1', 'd2', 'd3', 'd4']);
    const all = scen(pr, { times: t, need });
    const off = scen(pr, { times: t, need, hoursOpt: { includeQ: false, hours: { q: null, [day]: 0 } } });
    if (!all.solved.unlimited.reachable) continue;
    if (!off.solved.unlimited.reachable) continue;                                    // ×にすると届かなくなるのは、減らないに、含まれる
    if (off.solved.unlimited.hours < all.solved.unlimited.hours - 1e-9) bad.push({ i, t, pr, need, day, all: all.solved.unlimited.hours, off: off.solved.unlimited.hours });
  }
  ok(bad.length === 0, `○の日を×にすると、残りの自動の日の時間は、減らない（${N}通り）`, JSON.stringify(bad.slice(0, 2)));
}

// 4. 欲しい極星器の本数が増えるほど、毎日の時間は、減らない。毎日の時間を同じにしたときの、必要な通常肉も、減らない
//    （最短の時間で比べると、本数を増やしたとき、時間が増えて、そのぶん必要な肉が減ることがある。時間を増やすほど、肉が減る関係が、5. にある）
{
  const r = rng(404); const bad = [], bad2 = [];
  for (let i = 0; i < N; i++) {
    const t = times(r), pr = pick(r, ['time', 'meat']), need = pick(r, [3e9, 6e9]);
    let prev = null, hMax = null;
    for (const n of [0, 1, 2, 3]) {
      const sc = scen(pr, { times: t, need, star: n ? { n, q: sp.q } : null });
      if (!sc.solved.unlimited.reachable) { prev = null; continue; }
      const cur = { n, hours: sc.solved.unlimited.hours };
      if (prev && cur.hours < prev.hours - 1e-9) bad.push({ i, t, pr, need, prev, cur });
      prev = cur; hMax = cur.hours;
    }
    if (hMax == null) continue;
    let pm = null;                                                                    // 毎日の時間を、いちばん長い場合（本数 3 or その手前）にそろえる
    for (const n of [0, 1, 2, 3]) {
      const sc = scen(pr, { times: t, need, star: n ? { n, q: sp.q } : null, hoursOpt: { includeQ: false, hours: { q: null, d1: hMax, d2: hMax, d3: hMax, d4: hMax } } });
      if (!sc.req) { pm = null; continue; }
      if (pm && sc.req.meat < pm.meat - 1e-9) bad2.push({ i, t, pr, need, hMax, prev: pm, cur: { n, meat: sc.req.meat } });
      pm = { n, meat: sc.req.meat };
    }
  }
  ok(bad.length === 0, `欲しい極星器の本数が増えるほど、毎日の時間は、減らない（${N}通り × 4段階）`, JSON.stringify(bad.slice(0, 2)));
  ok(bad2.length === 0, `毎日の時間を同じにして、欲しい極星器の本数が増えるほど、必要な通常肉は、減らない（${N}通り × 4段階）`, JSON.stringify(bad2.slice(0, 2)));
}

// 5. 毎日の時間を増やすほど、必要な通常肉は、増えない
{
  const r = rng(505); const bad = [];
  for (let i = 0; i < N; i++) {
    const t = times(r), pr = pick(r, ['time', 'meat']), need = pick(r, [3e9, 6e9]);
    const base = scen(pr, { times: t, need });
    if (!base.solved.unlimited.reachable) continue;
    const H0 = base.solved.unlimited.hours;
    let prev = null;
    for (const dh of [0, 0.5, 1, 2, 4]) {
      const h = Math.min(17, Math.round((H0 + dh) * 20) / 20);
      const sc = scen(pr, { times: t, need, hoursOpt: { includeQ: false, hours: { q: null, d1: h, d2: h, d3: h, d4: h } } });
      if (!sc.req) { prev = null; continue; }
      const cur = { h, meat: sc.req.meat };
      if (prev && cur.meat > prev.meat + 1e-9) bad.push({ i, t, pr, need, prev, cur });
      prev = cur;
    }
  }
  ok(bad.length === 0, `毎日の時間を増やすほど、必要な通常肉は、増えない（${N}通り × 5段階）`, JSON.stringify(bad.slice(0, 2)));
}

console.log(`\n${fails === 0 ? `全部 OK（${total}件）` : `${fails} 件 NG / ${total}件`}`);
process.exit(fails ? 1 : 0);
