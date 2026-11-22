// かんたん計画の計算を、Web Worker（別のスレッド）で行う仕組みのテスト。
//   ・Worker で計算した結果は、ページの中（メインスレッド）で計算した結果と、完全に一致する
//   ・同じ入力を10回計算して、結果が一致する
//   ・CPU を4倍遅くしても（CDP の Emulation.setCPUThrottlingRate）、結果が一致する
//   ・入力中に、画面の処理が 50ms 以上止まらない（Worker のとき。ページの中で計算すると止まる）
//   ・Worker が使えなくても（作れない・読み込めない）、ページの中で計算して、同じ結果が出る
//   ・入力を続けて変えても、最後の入力の結果だけが出る（古い結果が上書きしない）
import { startServer, launchBrowser, localOnly } from './lib.mjs';

let fails = 0, total = 0;
const ok = (cond, msg, extra = '') => { total++; if (!cond) fails++; console.log(`${cond ? 'OK  ' : 'NG  '} ${msg}${!cond && extra ? '\n      ' + String(extra).slice(0, 700) : ''}`); };

const { base, close: closeServer } = await startServer();
const browser = await launchBrowser();

const FULL = { h90: 90, h95: 120, h100: 150, h150: 180, h200: 300, h250: 900 };
// 重い問題：時間がばらばらの討伐タイム（検証の「rnd7」と同じ作り方）
const HEAVY = (() => {
  let seed = 777; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  let t;
  for (let i = 0; i < 8; i++) t = { h90: 40 + Math.floor(rnd() * 120), h95: 60 + Math.floor(rnd() * 160), h100: 80 + Math.floor(rnd() * 200), h150: 60 + Math.floor(rnd() * 400), h200: 150 + Math.floor(rnd() * 700), h250: 400 + Math.floor(rnd() * 1800) };
  return t;                                                              // 8番目（検証の rnd7）
})();

const STATES = [
  { goalKind: 'number', goalText: '60億', meatText: '40000' },
  { goalKind: 'number', goalText: '60億' },
  { goalKind: 'number', goalText: '100億', meatText: '3000', matText: '400' },
  { goalKind: 'number', goalText: '1億5000万', curText: '5000万', meatText: '20000', where: 'd2' },
  { goalKind: 'none', meatText: '40000', normalHours: '4' },
  { goalKind: 'number', goalText: '60億', meatText: '40000', starCollect: 'yes', starText: '3' },
  { goalKind: 'number', goalText: '60億', meatText: '40000', starCollect: 'yes', starText: '1', starMode: 'p90', starDiff: 'h90' },
  { goalKind: 'none', meatText: '40000', normalHours: '17', starCollect: 'yes', starText: '2' },
  { goalKind: 'number', goalText: '60億', meatText: '40000', marks: { d1: 'o', d2: 't', d3: 'x', d4: 'o' } },
  { goalKind: 'number', goalText: '80億', meatText: '50000', detail: true, hours: { d1: '', d2: '5', d3: '', d4: '' } },
  { goalKind: 'number', goalText: '60億', timeMode: 'one', oneId: 'h150', oneMin: '3', oneSec: '0', meatText: '40000' },
  { goalKind: 'number', goalText: '60億', timeMode: 'rough', rough: { h150: { min: '5', runs: '100' }, h200: { min: '5', runs: '20' }, h250: { min: '30', runs: '30' } }, meatText: '40000' },
  { goalKind: 'number', goalText: '9999億', meatText: '40000' },
  { goalKind: 'number', goalText: '30億', meatText: '1000', matText: '0', where: 'd3' },
];

async function openPlan(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  await localOnly(page);
  if (opts.route) await page.route(opts.route.pattern, opts.route.handler);
  await page.addInitScript(([times, noWorker, noWorkerApi]) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('gbf_kj_times', JSON.stringify(times));
    if (noWorker) window.KJ_NO_WORKER = true;
    if (noWorkerApi) window.Worker = undefined;
  }, [opts.times || FULL, !!opts.noWorker, !!opts.noWorkerApi]);
  await page.goto(`${base}/kosenjou.html#plan`);
  await page.evaluate(() => planPanel.whenIdle());
  return { ctx, page, errors };
}

/** 入力の一覧を、ページの中（メインスレッド）と、Worker の両方で計算して、結果の文字列を返す */
const computeBoth = (page, states) => page.evaluate(async (states) => {
  const env = planPanel.env();
  const fresh = planPanel.freshState();
  const mk = (o) => ({ ...fresh, ...o, marks: { ...fresh.marks, ...(o.marks || {}) }, hours: { ...fresh.hours, ...(o.hours || {}) }, rough: { ...(o.rough || {}) }, skipped: {} });
  const j = (x) => JSON.stringify(x, (k, v) => (v === Infinity ? 'Infinity' : v));
  const worker = new Worker('kosenjou-worker.js');
  const viaWorker = (W) => new Promise((res, rej) => { worker.onmessage = (e) => (e.data.error ? rej(new Error(e.data.error)) : res(e.data.R)); worker.onerror = (e) => rej(new Error(e.message)); worker.postMessage({ id: 1, W, env }); });
  const t0 = performance.now();
  const main = states.map((o) => j(PlanCore.compute(JSON.parse(JSON.stringify(mk(o))), env)));
  const tMain = performance.now() - t0;
  const wk = [];
  for (const o of states) wk.push(j(await viaWorker(mk(o))));
  worker.terminate();
  return { main, wk, tMain };
}, states);

// ── 1. Worker の結果は、メインスレッドの結果と、完全に一致する ──
let reference;
{
  const { ctx, page, errors } = await openPlan();
  const r = await computeBoth(page, STATES);
  reference = r.main;
  const same = r.main.filter((m, i) => m === r.wk[i]).length;
  ok(same === STATES.length, `Worker で計算した結果は、ページの中で計算した結果と、完全に一致する（${same}/${STATES.length}件）`, r.main.map((m, i) => (m === r.wk[i] ? '' : `#${i}`)).filter(Boolean).join(' '));
  ok(await page.evaluate(() => !!planPanel.worker), 'Worker が使われている（planPanel.worker がある）');
  ok(r.main.some((m) => m.includes('"views"') && m.includes('"req"')), '比べた中に、目標つき（必要な肉まで出る）の結果が入っている');
  // ── 2. 同じ入力を10回 ──
  const ten = await page.evaluate(async (o) => {
    const env = planPanel.env(); const fresh = planPanel.freshState();
    const W = { ...fresh, ...o };
    const j = (x) => JSON.stringify(x, (k, v) => (v === Infinity ? 'Infinity' : v));
    const worker = new Worker('kosenjou-worker.js');
    const viaWorker = () => new Promise((res) => { worker.onmessage = (e) => res(j(e.data.R)); worker.postMessage({ id: 1, W, env }); });
    const out = [];
    for (let i = 0; i < 10; i++) out.push(await viaWorker());
    worker.terminate();
    return out;
  }, STATES[0]);
  ok(ten.every((x) => x === ten[0]), '同じ入力を10回、Worker で計算して、結果が完全に一致する');
  ok(errors.length === 0 || errors.every((e) => /kofiWidgetOverlay/.test(e)), '画面のエラーがない', errors.join(' | '));
  await ctx.close();
}

// ── 3. CPU を4倍遅くしても、結果が一致する ──
{
  const { ctx, page } = await openPlan();
  const client = await ctx.newCDPSession(page);
  await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const r = await computeBoth(page, STATES);
  await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const r1 = await computeBoth(page, STATES);
  const sameMain = r.main.filter((m, i) => m === reference[i]).length;
  const sameWk = r.wk.filter((m, i) => m === reference[i]).length;
  ok(sameMain === STATES.length, `CPU を4倍遅くしても、ページの中で計算した結果が一致する（${sameMain}/${STATES.length}件。メインスレッドの計算時間 ${Math.round(r1.tMain)}ms → 4倍遅い間は ${Math.round(r.tMain)}ms）`, `${Math.round(r1.tMain)} → ${Math.round(r.tMain)}`);
  ok(r.tMain > r1.tMain * 1.5, 'CPU の制限が効いている（遅い間のほうが、計算時間が長い）', `${Math.round(r1.tMain)} vs ${Math.round(r.tMain)}`);
  ok(sameWk === STATES.length, `CPU を4倍遅くしている間に、Worker で計算した結果も一致する（${sameWk}/${STATES.length}件）`);
  await ctx.close();
}

// ── 4. 入力中に、画面の処理が 50ms 以上止まらない ──
/** 目標と討伐タイムを、入力しながら、メインスレッドの 50ms 以上の処理（longtask）を数える */
async function typingStalls(page) {
  await page.evaluate(() => { window.__long = []; new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(Math.round(e.duration)))).observe({ entryTypes: ['longtask'] }); });
  await page.fill('#pl-goal', '');
  await page.type('#pl-goal', '70億', { delay: 40 });
  await page.click('[data-head="time"]');
  for (const [id, min] of [['h150', '3'], ['h200', '5'], ['h250', '15']]) {
    await page.fill(`[data-tf="${id}"][data-part="min"]`, '');
    await page.type(`[data-tf="${id}"][data-part="min"]`, min, { delay: 40 });
    await page.fill(`[data-tf="${id}"][data-part="sec"]`, '');
    await page.type(`[data-tf="${id}"][data-part="sec"]`, '30', { delay: 40 });
  }
  await page.evaluate(() => planPanel.whenIdle());
  await page.waitForTimeout(300);
  return page.evaluate(() => window.__long);
}
{
  const a = await openPlan({ times: HEAVY });
  const longW = await typingStalls(a.page);
  ok(await a.page.evaluate(() => !!planPanel.worker), '入力中のテスト：Worker で計算している');
  ok(longW.length === 0, `入力中（目標・討伐タイム）に、画面の処理が 50ms 以上止まらない（Worker・重い討伐タイム。50ms 以上の処理 ${longW.length}回 ${JSON.stringify(longW)}）`, JSON.stringify(longW));
  await a.ctx.close();
  const b = await openPlan({ times: HEAVY, noWorker: true });
  const longS = await typingStalls(b.page);
  console.log(`      （参考）ページの中で計算すると、50ms 以上の処理は ${longS.length}回 ${JSON.stringify(longS)}`);
  ok(longS.length > 0, 'テストの確かめ：ページの中で計算すると、同じ入力で、50ms 以上止まる（止まりを検出できるテストである）', JSON.stringify(longS));
  await b.ctx.close();
}

// ── 5. Worker が使えないときは、ページの中で計算する ──
{
  const a = await openPlan({ noWorkerApi: true });
  ok(await a.page.evaluate(() => planPanel.worker === null), 'Worker が使えない環境（Worker が未定義）：planPanel.worker は null');
  await a.page.fill('#pl-goal', '60億');
  await a.page.click('[data-head="now"]');
  await a.page.fill('[data-f="meatText"]', '40000');
  const text = (await a.page.innerText('[data-resbody]')).replace(/\s+/g, ' ');
  ok(text.includes('毎日 約 6時間33分ずつで、届きます') && text.includes('必要な通常肉 4,200個'), 'Worker が使えない環境でも、結果が出る（毎日 6時間33分・必要な肉 4,200個）', text.slice(0, 400));
  await a.ctx.close();
  const b = await openPlan({ route: { pattern: '**/kosenjou-worker.js', handler: (route) => route.fulfill({ status: 404, body: 'nf' }) } });
  await b.page.fill('#pl-goal', '60億');
  await b.page.click('[data-head="now"]');
  await b.page.fill('[data-f="meatText"]', '40000');
  await b.page.evaluate(() => planPanel.whenIdle());
  await b.page.waitForTimeout(300);
  const text2 = (await b.page.innerText('[data-resbody]')).replace(/\s+/g, ' ');
  ok(await b.page.evaluate(() => planPanel.worker === null), 'Worker のファイルを読み込めないとき：Worker をあきらめて、ページの中で計算する');
  ok(text2.includes('毎日 約 6時間33分ずつで、届きます') && text2.includes('必要な通常肉 4,200個'), 'Worker のファイルを読み込めなくても、結果が出る', text2.slice(0, 400));
  ok(b.errors.every((e) => /kofiWidgetOverlay/.test(e)), 'そのとき、画面のエラーが出ない', b.errors.join(' | '));
  await b.ctx.close();
}

// ── 6. 入力を続けて変えても、最後の入力の結果だけが出る ──
{
  const { ctx, page } = await openPlan({ times: HEAVY });
  await page.evaluate(() => {
    const el = document.getElementById('pl-goal');
    for (const v of ['30億', '40億', '50億', '80億']) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }   // 待たずに、続けて変える
  });
  await page.evaluate(() => planPanel.whenIdle());
  const shown = await page.evaluate(() => ({ goal: planPanel.R.goal.value, sum: document.querySelector('[data-sum]').innerText }));
  ok(shown.goal === 8000000000, `入力を待たずに続けて変えても、最後の入力（80億）の結果が出る（${shown.goal}）`, JSON.stringify(shown));
  await ctx.close();
}

await browser.close();
closeServer();
console.log(`\n${fails === 0 ? `全部 OK（${total}件）` : `${fails} 件 NG / ${total}件`}`);
process.exit(fails ? 1 : 0);
