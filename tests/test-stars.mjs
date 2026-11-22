// 極星器の見込み・欲しい本数の計算を、ブラウザなしで確かめるテスト。
//   ・本数の分布（ポアソン二項分布）：1つの難易度なら二項分布と一致、複数の難易度なら、モンテカルロ法（10万回）と一致
//   ・期待本数 = 各難易度の「回数 × 1周の確率」の合計。確率不明の難易度は、数えない
//   ・欲しい本数を整数計画に入れた計画：期待本数が足りている・1日の上限（17時間）を超えない・本数を増やしても、毎日の時間と必要な肉は減らない
//   ・難易度を指定したとき、ほかの難易度は、極星器のない計画の回数を超えない
import vm from 'node:vm';
import { loadEngine, read } from './engine.mjs';

let fails = 0, total = 0;
const ok = (cond, msg, extra = '') => { total++; if (!cond) fails++; console.log(`${cond ? 'OK  ' : 'NG  '} ${msg}${!cond && extra ? '\n      ' + String(extra).slice(0, 700) : ''}`); };

const E = loadEngine({ scripts: ['kosenjou-plan-core.js'] });
const PC = E.PlanCore;
const FULL = { h90: 90, h95: 120, h100: 150, h150: 180, h200: 300, h250: 900 };

// トレハンの設定（既定：200HELL・箱 4%・倍率 120%（団サポ 20%）・アイテム 8%）から、難易度ごとの確率を出す（トレハンタブの計算そのもの）
const th = vm.createContext({ window: {} });
vm.runInContext(read('kosenjou-trehun.js'), th, { filename: 'kosenjou-trehun.js' });
const TH = th.window.TrehunPanel;
const DEF = { diff: 'h200', boxBase: 4, itemRate: 8, trehun: 0, tears: 0, tearsOdds: 0, weathercock: 3, essel: 0, character: 0, coexist: false, richard: false, minic: false, weapon: 0, dbee: false, mainStone: 0, friendStone: 0, artifact: 0, precious: false, preciousFrame: 3 };
const ids = E.HELL_DIFFS.map((d) => d.id);

// ── B1：難易度ごとの確率 ──
{
  const per = TH.perDiff(DEF, ids);
  const want = { h90: 2, h95: 2.5, h100: 3, h150: 3.5, h200: 4 };
  const r4 = (v) => Math.round(v * 10000) / 10000;
  ok(Object.keys(want).every((id) => per[id].known && r4(per[id].box) === r4(want[id] * 1.2) && r4(per[id].item) === r4(want[id] * 1.2 * 0.08)), 'B1: 難易度ごとの確率は、箱の基本率 × 倍率（120%）× アイテム率（8%）。200HELL は 0.384%', JSON.stringify(per));
  ok(per.h250.known === false && per.h250.item === undefined, 'B1: 箱の基本率のデータがない難易度（250HELL）は、確率不明（勝手に補わない）');
  // トレハンタブで、その難易度を選んだとき（箱の基本率が、その難易度の値に変わる）と、同じ値
  const same = Object.keys(want).every((id) => { const s = { ...DEF, diff: id, boxBase: want[id] }; return r4(TH.calc(s).item) === r4(per[id].item); });
  ok(same, 'B1: 各難易度の確率は、トレハンタブで、同じ難易度を選んだときの値と一致する');
  const per2 = TH.perDiff({ ...DEF, diff: 'h100', boxBase: 3.3 }, ids);
  ok(Math.abs(per2.h100.box - 3.3 * 1.2) < 1e-12 && Math.abs(per2.h90.box - 2 * 1.2) < 1e-12, 'B1: 選んでいる難易度の箱の基本率は、手で直した値。ほかは、表の値');
}

// ── B2：本数の分布 ──
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
{
  // 1つの難易度：二項分布と、定義から（1本ずつ足して）出した値が一致する
  const binom = (n, q) => { const pmf = [Math.pow(1 - q, n)]; for (let k = 0; k < n; k++) pmf.push(pmf[k] * (n - k) / (k + 1) * q / (1 - q)); return pmf; };
  const bruteN90 = (n, q) => { let c = 0; const p = binom(n, q); for (let j = 0; j <= n; j++) { c += p[j]; if (c > 0.1) return j; } return n; };
  let allSame = true; const cases = [];
  for (const [n, q] of [[100, 0.00384], [300, 0.00384], [700, 0.00336], [1000, 0.00192], [2000, 0.00192], [500, 0.05], [50, 0.3]]) {
    const st = PC.starStats({ x: n }, { x: q }, null);
    const b = bruteN90(n, q);
    cases.push([n, q, st.n90, b]);
    if (st.n90 !== b || Math.abs(st.mean - n * q) > 1e-12) allSame = false;
  }
  ok(allSame, 'B2: 1つの難易度のときの「90%の確率で ◯本以上」は、二項分布から直接数えた値と一致する', JSON.stringify(cases));
  const st = PC.starStats({ x: 700 }, { x: 0.00384 }, 3);
  const tail = (() => { const p = binom(700, 0.00384); return 1 - p[0] - p[1] - p[2]; })();
  ok(Math.abs(st.pAtLeast - tail) < 1e-12, 'B2: 「n本以上の確率」が、二項分布の値と一致する');
}
{
  // 複数の難易度（確率がちがう）：モンテカルロ法 10万回
  const r = rng(99);
  const runsById = { h90: 80, h150: 130, h200: 260, h250: 40 };
  const q = { h90: 0.00192, h150: 0.00336, h200: 0.00384 };                      // h250 は確率不明：数えない
  const st = PC.starStats(runsById, q, 3);
  ok(Math.abs(st.mean - (80 * 0.00192 + 130 * 0.00336 + 260 * 0.00384)) < 1e-12, 'B2: 期待本数 = 各難易度の「回数 × 1周の確率」の合計（確率不明の難易度は、数えない）');
  const N = 100000; const counts = new Map(); const groups = Object.keys(q).map((id) => [runsById[id], q[id]]);
  let atLeast3 = 0;
  for (let t = 0; t < N; t++) { let x = 0; for (const [n, p] of groups) for (let k = 0; k < n; k++) if (r() < p) x++; counts.set(x, (counts.get(x) || 0) + 1); if (x >= 3) atLeast3++; }
  const ge = (k) => { let c = 0; for (const [x, n] of counts) if (x >= k) c += n; return c / N; };
  const eps = 0.006;                                                              // 10万回の誤差（標準誤差は 0.0015 くらい）の 4倍ほど
  ok(ge(st.n90) >= 0.9 - eps && ge(st.n90 + 1) <= 0.9 + eps, `B2: 「90%で ${st.n90}本以上」が、モンテカルロ法（10万回）と一致する（${st.n90}本以上 ${(ge(st.n90) * 100).toFixed(2)}%・${st.n90 + 1}本以上 ${(ge(st.n90 + 1) * 100).toFixed(2)}%）`);
  ok(Math.abs(atLeast3 / N - st.pAtLeast) < 0.006, `B2: 「3本以上の確率」が、モンテカルロ法と一致する（${(atLeast3 / N * 100).toFixed(2)}% と ${(st.pAtLeast * 100).toFixed(2)}%）`);
}
{
  // 本数が多め（平均 4.4本。「90%で 2本以上」くらい）の、モンテカルロ法
  const r = rng(7);
  const runsById = { h90: 600, h150: 500, h200: 400 }, q = { h90: 0.00192, h150: 0.00336, h200: 0.00384 };
  const st = PC.starStats(runsById, q, null);
  const N = 100000; const counts = new Map(); const groups = Object.keys(q).map((id) => [runsById[id], q[id]]);
  for (let t = 0; t < N; t++) { let x = 0; for (const [n, p] of groups) for (let k = 0; k < n; k++) if (r() < p) x++; counts.set(x, (counts.get(x) || 0) + 1); }
  const ge = (k) => { let c = 0; for (const [x, n] of counts) if (x >= k) c += n; return c / N; };
  ok(st.n90 >= 1 && ge(st.n90) >= 0.9 - 0.006 && ge(st.n90 + 1) <= 0.9 + 0.006, `B2: 本数が多めでも、「90%で ${st.n90}本以上」が、モンテカルロ法（10万回）と一致する（${st.n90}本以上 ${(ge(st.n90) * 100).toFixed(2)}%・${st.n90 + 1}本以上 ${(ge(st.n90 + 1) * 100).toFixed(2)}%）`);
}
{
  // 周回数が多くても（桁あふれしない）、確率の高い難易度でも、合計が 1 になる
  const { lo, pmf } = PC.starPmf([{ n: 20000, q: 0.12 }, { n: 5000, q: 0.004 }]);
  const sum = pmf.reduce((a, b) => a + b, 0);
  ok(Math.abs(sum - 1) < 1e-9 && lo > 1000, `B2: 周回数が 2万回・確率 12% でも、分布が計算できる（合計 ${sum.toFixed(12)}・下限 ${lo}本）`);
}

// ── B2/B3：計画への組み込み ──
const perDiff = TH.perDiff(DEF, ids);
const env = { rows: [], points: [], killTimes: FULL, trehun: { diff: 'h200', item: 0.384, box: 4.8, itemRate: 8, perDiff } };
const W0 = { open: 'goal', goalKind: 'number', goalText: '60億', goalRank: 0, where: 'pre', curText: '', meatText: '40000', matText: '', collectText: '', starText: '', starMode: 'avg', starCollect: 'no', starDiff: '', timeMode: 'full', oneId: 'h150', oneMin: '', oneSec: '', gatherMin: '10', gatherMeat: '', triHours: '3', normalHours: '4', detail: false, tab: 'time', rough: {}, marks: { d1: 'o', d2: 'o', d3: 'o', d4: 'o' }, hours: { d1: '', d2: '', d3: '', d4: '' }, skipped: {} };
const compute = (o, e = env) => PC.compute({ ...W0, ...o }, e);
const qOf = (id) => (perDiff[id] && perDiff[id].known ? perDiff[id].item / 100 : 0);

{
  const R = compute({});
  const v = R.views.time;
  const expect = Object.entries(v.stars.runsById).reduce((a, [id, n]) => a + n * qOf(id), 0);
  ok(Math.abs(v.stars.mean - expect) < 1e-12 && v.stars.mean > 0, `B2: 欲しい本数を入れなくても、期待本数が出る（約 ${v.stars.mean.toFixed(2)}本）。計画の「回数 × 1周の確率」の合計と一致`);
  // 確率のある難易度が 200HELL だけのとき：期待本数 = 計画の 200HELL の回数 × 0.384%
  const only200 = { ...env, trehun: { ...env.trehun, perDiff: { ...perDiff, h90: { known: false }, h95: { known: false }, h100: { known: false }, h150: { known: false } } } };
  const R2 = compute({}, only200);
  const v2 = R2.views.time, n200 = v2.stars.runsById.h200;
  ok(n200 > 0 && Math.abs(v2.stars.mean - n200 * 0.00384) < 1e-12, `B2: 確率のある難易度が 200HELL だけのとき、期待本数は「計画の 200HELL の回数（${n200}）× 0.384%」と一致する（${v2.stars.mean.toFixed(4)}）`);
  ok(v2.stars.unknownUsed.includes('150HELL') && v2.stars.unknownUsed.includes('250HELL'), 'B2: 確率不明の難易度（回数があるもの）が、注記のために、わかる');
  // 目標を決めないとき
  const Rf = compute({ goalKind: 'none' });
  ok(Rf.forward && Rf.forward.time.stars.mean > 0 && Rf.forward.time.stars.n90 >= 0, 'B2: 目標を決めないときも、期待本数が出る');
  // 討伐タイムがないとき（回数の表）：各難易度だけで回したときの本数
  const Rc = PC.compute({ ...W0 }, { ...env, killTimes: {} });
  const row = (id) => Rc.counts.find((c) => c.id === id);
  ok(Rc.counts && Math.abs(row('h200').stars - row('h200').runs * 0.00384) < 1e-9 && row('h250').stars === null && row('h90').stars > 0, 'B2: 討伐タイムがないとき、回数の表に、各難易度だけで回したときの本数の列がある（250HELL は確率不明）');
}

{
  // 欲しい本数：期待本数が足りている・1日の上限を超えない・増やしても減らない
  const rows = [];
  for (const mode of ['avg']) for (const extra of ['', 'h90', 'h200']) {
    let prev = null;
    for (const n of [0, 1, 2, 3, 4]) {
      const R = compute({ starCollect: n ? 'yes' : 'no', starText: String(n || ''), starMode: mode, starDiff: extra });
      for (const pr of ['time', 'meat']) {
        const v = R.views[pr];
        rows.push({ extra, n, pr, reachable: v.reachable, hours: v.autoHours, mean: v.stars.mean, req: v.req && v.req.meat, blocked: v.starBlocked, maxDay: Math.max(...v.days.map((d) => d.hours)) });
      }
      prev = R;
    }
  }
  const okRows = rows.filter((r) => r.n > 0 && !r.blocked);
  ok(okRows.length > 8 && okRows.every((r) => r.mean >= r.n - 1e-9), `B3: 欲しい本数を入れると、計画の期待本数が、その本数以上になる（${okRows.length}通り）`, JSON.stringify(okRows.filter((r) => r.mean < r.n - 1e-9)));
  ok(rows.every((r) => r.maxDay <= 17 + 1e-9), 'B3: どの日も、極星器の周回を含めて、1日 17時間を超えない（警告ではなく、計画の上で守る）', JSON.stringify(rows.filter((r) => r.maxDay > 17)));
  // 本数を増やしても、毎日の時間と必要な肉は減らない（届くあいだ）
  let mono = true; const bad = [];
  for (const extra of ['', 'h90', 'h200']) for (const pr of ['time', 'meat']) {
    const seq = rows.filter((r) => r.extra === extra && r.pr === pr && r.reachable && !r.blocked);
    for (let i = 1; i < seq.length; i++) if (seq[i].hours < seq[i - 1].hours - 1e-9 || seq[i].req < seq[i - 1].req - 1e-9) { mono = false; bad.push([extra, pr, seq[i - 1], seq[i]]); }
  }
  ok(mono, 'B3: 欲しい本数を増やしても、毎日の時間と必要な通常肉は、減らない', JSON.stringify(bad[0]));
  ok(rows.some((r) => r.blocked), 'B3: 1日 17時間でも集められない本数は、集められないとわかる（starBlocked）');
}

{
  // 難易度を指定したとき：ほかの難易度は、極星器のない計画の回数を超えない。通常の期待本数 + 追加の期待本数 ≥ n
  const R0 = compute({});
  const R = compute({ starCollect: 'yes', starText: '2', starDiff: 'h90' });
  const v = R.views.time, b = R0.views.time;
  const over = Object.entries(v.stars.runsById).filter(([id, n]) => id !== 'h90' && n > (b.stars.runsById[id] || 0));
  ok(over.length === 0, 'B3: 難易度を指定したとき（90HELL）、ほかの難易度の周回は、極星器のない計画の回数を超えない', JSON.stringify(over));
  const normal = Object.entries(v.stars.runsById).filter(([id]) => id !== 'h90').reduce((a, [id, n]) => a + n * qOf(id), 0);
  const extra = (v.stars.runsById.h90 || 0) * qOf('h90');
  ok(normal + extra >= 2 - 1e-9 && v.stars.runsById.h90 > 0, `B3: 「通常の回数の期待本数（${normal.toFixed(3)}）+ 追加の回数 × その確率（${extra.toFixed(3)}）」が、欲しい本数（2）以上`);
  // 回し方で外れている難易度でも、追加の周回には使える（肉優先では、90HELL は候補にない）
  const Rm = compute({ starCollect: 'yes', starText: '1', starDiff: 'h90' });
  ok(Rm.views.meat.stars.runsById.h90 > 0, 'B3: 回し方（肉優先）で候補にない難易度（90HELL）も、追加の周回には使える');
  // 確率不明の難易度は、指定しても、数えない（おまかせと同じ）
  const Ru = compute({ starCollect: 'yes', starText: '1', starDiff: 'h250' });
  const Ra = compute({ starCollect: 'yes', starText: '1', starDiff: '' });
  ok(JSON.stringify(Ru.views.time.stars.runsById) === JSON.stringify(Ra.views.time.stars.runsById), 'B3: 確率不明の難易度（250HELL）を指定しても、本数には数えない（おまかせと同じ結果）');
}

{
  // 90% で見積もる：n本以上になる確率が 90% 以上（届かないときは、そう伝える）
  const R = compute({ starCollect: 'yes', starText: '1', starMode: 'p90' });
  const v = R.views.time;
  ok(v.stars.pAtLeast >= 0.9 - 1e-9 || v.p90Unmet, `B3: 90%で見積もると、1本以上になる確率が 90% 以上になる（${(v.stars.pAtLeast * 100).toFixed(1)}%）`);
  const Ra = compute({ starCollect: 'yes', starText: '1', starMode: 'avg' }).views.time;
  ok(v.autoHours >= Ra.autoHours - 1e-9 && v.stars.mean >= Ra.stars.mean - 1e-9, `B3: 90%で見積もると、平均で見積もるより、時間・期待本数が、減らない（${v.autoHours}h・${v.stars.mean.toFixed(2)}本 と ${Ra.autoHours}h・${Ra.stars.mean.toFixed(2)}本）`);
}

{
  // 日ごとの時間を決めたとき：決めた時間を超えない。目標を決めない（時間が決まっている）ときの計画
  const R = compute({ marks: { d1: 'o', d2: 't', d3: 'o', d4: 'o' }, triHours: '3', starCollect: 'yes', starText: '2' });
  const v = R.views.time;
  ok(v.days.find((d) => d.id === 'd2').hours === 3 && v.days.every((d) => d.hours <= 17 + 1e-9), 'B3: △の日（3時間）は、極星器の周回を入れても、3時間のまま');
  const Rf = compute({ goalKind: 'none', normalHours: '17', starCollect: 'yes', starText: '2' });
  const f = Rf.forward.time;
  ok(!f.starUnmet && f.stars.mean >= 2 - 1e-9 && f.days.every((d) => d.hours <= 17 + 1e-9), `B3: 目標を決めないとき、時間が足りれば、極星器の制約を守る貢献度最大の計画（期待 ${f.stars.mean.toFixed(2)}本）`);
  const Rg = compute({ goalKind: 'none', normalHours: '1', starCollect: 'yes', starText: '2' });
  ok(Rg.forward.time.starUnmet === true, 'B3: 目標を決めないとき、時間が足りなければ、集められないとわかる（starUnmet）');
}

console.log(`\n${fails === 0 ? `全部 OK（${total}件）` : `${fails} 件 NG / ${total}件`}`);
process.exit(fails ? 1 : 0);
