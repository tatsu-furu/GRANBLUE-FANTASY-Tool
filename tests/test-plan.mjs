import { startServer, launchBrowser, shot } from './lib.mjs';
const { base, close: closeServer } = await startServer();
const browser = await launchBrowser();
let fails = 0, total = 0;
const ok = (cond, msg, extra = '') => { total++; if (!cond) fails++; console.log(`${cond ? 'OK  ' : 'NG  '} ${msg}${!cond && extra ? '\n      ' + String(extra).slice(0, 600) : ''}`); };

const FULL = { h90: 90, h95: 120, h100: 150, h150: 180, h200: 300, h250: 900 };
const BORDER = { rows: [{ label: '2000位', current: 123456000000, final: 150000000000 }, { label: '10万位', current: 9500000000, final: null }], mine: null, days: 0, hours: 0, target: 0 };
// 入れた保存を、開き直しても上書きしない（sessionStorage で、最初の1回だけ）
async function openPlan(file, { w = 1100, seed = {}, plan = null, errors, hash = '#plan' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
  const page = await ctx.newPage();
  await page.route('**/*', (route) => (new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort()));
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  await page.addInitScript(([s, p]) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    for (const [k, v] of Object.entries(s)) localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
    if (p) localStorage.setItem('gbf_kj_plan', JSON.stringify(p));
  }, [seed, plan]);
  if (WORKER) {                                                                // Worker のときは、操作のたびに、計算が終わるのを待つ
    for (const m of ['fill', 'click', 'check', 'uncheck', 'selectOption', 'press', 'type', 'dispatchEvent', 'reload']) {
      const orig = page[m].bind(page);
      page[m] = async (...a) => { const r = await orig(...a); await settle(page); return r; };
    }
  }
  await page.goto(`${base}/${file}${hash}`);
  if (WORKER) await settle(page);
  return { ctx, page };
}
// 計算の場所：既定は、ページの中（Worker なし）。--worker（または KJ_WORKER=1）を付けると、Worker で計算する（同じテストを、Worker で通す）
const WORKER = process.env.KJ_WORKER === '1' || process.argv.includes('--worker');
if (!WORKER) {                                                               // どの画面（コンテキスト）でも、Worker を使わない
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...a) => { const c = await newContext(...a); await c.addInitScript(() => { window.KJ_NO_WORKER = true; }); return c; };
}
const settle = (page) => page.evaluate(() => (typeof planPanel !== 'undefined' ? planPanel.whenIdle() : 0));      // planPanel は const なので、window の持ち物ではない
const T = (page, sel) => page.innerText(sel).then((t) => t.replace(/\s+/g, ' ').trim());
const openStep = async (page, id) => { if (await page.evaluate((id) => document.querySelector(`[data-body="${id}"]`).hidden, id)) await page.click(`[data-head="${id}"]`); };

for (const file of ['kosenjou.html', 'kosenjou-beta.html']) {
  console.log(`\n===== ${file} =====`);
  const errors = [];

  // ---- 順番に入れる ----
  {
    const { ctx, page } = await openPlan(file, { seed: { gbf_kj_times: FULL }, errors });
    ok(await page.evaluate(() => document.querySelector('.tabs .tab-btn').dataset.tab === 'plan' && document.querySelector('.tab-content.active').id === 'tab-plan'), 'かんたん計画: 一番左のタブ。#plan で開く');
    ok(!(await page.evaluate(() => document.querySelector('[data-body="goal"]').hidden)) && (await page.evaluate(() => ['now', 'star', 'time', 'days'].every((id) => document.querySelector(`[data-body="${id}"]`).hidden))), '順番に入れる: はじめは ① だけが開いている');
    ok((await T(page, '[data-resbody]')).includes('①で目標を入れてください') && (await T(page, '[data-sum]')).includes('①目標を入れる'), '結果: 目標がないときは、案内（要約の帯にも）');
    await page.fill('#pl-goal', '60億');
    ok((await T(page, '[data-echo="goal"]')) === '＝ 6,000,000,000' && (await T(page, '[data-summ="goal"]')) === '60億' && (await T(page, '[data-state="goal"]')) === '入力済み', '① 目標: 「60億」→ 6,000,000,000。要約と状態が出る');
    await page.click('[data-next="goal"]');
    ok(!(await page.evaluate(() => document.querySelector('[data-body="now"]').hidden)) && (await page.evaluate(() => document.querySelector('[data-body="goal"]').hidden)), '「次へ」で、次の ② が開く');
    await page.fill('[data-f="meatText"]', '40000');
    const res = await T(page, '[data-resbody]');
    ok(res.includes('毎日 約 6時間33分ずつで、届きます') && res.includes('必要な通常肉 4,200個') && res.includes('いま 40,000個で足ります') && res.includes('必要な250専用素材 1,040個') && res.includes('難易度ごとの時間：150HELL 6時間36分・200HELL 6時間30分・250HELL 13時間'), '結果: 目標60億・肉40,000個 → 毎日 6時間33分・必要な肉 4,200個・素材 1,040個・難易度ごとの時間', res);
    ok((await T(page, '[data-sum]')).includes('時間優先：毎日 約 6時間33分ずつで、届きます') && (await T(page, '[data-sum]')).includes('必要な通常肉 4,200個（足ります）'), '上の要約の帯に、要点が出る');
    ok(res.includes('▶ 時間優先：毎日 約 6時間33分ずつで、届きます・必要な通常肉 4,200個') && /肉優先：毎日 約 6時間3\d分ずつで、届きます・必要な通常肉 3,980個/.test(res), '結果: 時間優先と肉優先を、1行ずつ並べて比べられる', res);
    await page.click('[data-rt="meat"]');
    ok((await T(page, '[data-sum]')).includes('肉優先：') && (await T(page, '[data-resbody]')).includes('▶ 肉優先') && (await T(page, '[data-resbody]')).includes('必要な通常肉 3,980個'), '結果のタブ: 肉優先に切り替わる');
    await page.click('[data-rt="time"]');
    // スケジュールタブと、同じ計算
    const same = await page.evaluate(() => {
      const diffs = KJ_CORE.planDiffsFrom(KJ_CORE.getKillTimes(), []);
      const sc = KJ_CORE.scheduleScenario('time', { diffs, stock: 40000, mat250: null, need: 6000000000, hoursOpt: { includeQ: false, hours: { q: null, d1: null, d2: null, d3: null, d4: null } } });
      return { req: sc.req.meat, mat: sc.req.mat, hours: sc.solved.actual.hours, plan: planPanel.R.views.time.req.meat, planHours: planPanel.R.views.time.autoHours };
    });
    ok(same.req === same.plan && same.hours === same.planHours && same.req === 4200 && same.mat === 1040, 'スケジュールの計算と、同じ結果（必要な肉・時間）', JSON.stringify(same));
    // A2：日ごとのカードは、「目標に届く中で、肉が最小の計画」（必要な通常肉を求めたときの計画）
    const cardsNow = await page.evaluate(() => [...document.querySelectorAll('[data-resbody] .pl-card')].map((c) => c.innerText.replace(/\s+/g, ' ').trim()));
    const sumMeat = cardsNow.reduce((a, c) => { const m = c.match(/肉 ([\d,]+)/); return a + (m ? parseInt(m[1].replace(/,/g, ''), 10) : 0); }, 0);
    ok(sumMeat === 4200, `A2: 肉が足りるとき、日ごとのカードの肉の合計（${sumMeat}）が「必要な通常肉」（4,200）と一致する`, cardsNow.join(' | '));
    ok(cardsNow.filter((c) => /余裕 \d+分/.test(c)).length === 4, 'A2: 日ごとのカードに「余裕 ◯分」が出る（4日とも）', cardsNow.join(' | '));
    ok(await page.evaluate(() => planPanel.R.views.time.minMeat === true && planPanel.R.views.meat.minMeat === true), 'A2: 肉が足りるとき、時間優先・肉優先とも、カードは「肉が最小の計画」');
    await ctx.close();
  }

  // ---- A1：極星器の計算に使った、難易度と確率を出す ----
  {
    const a = await openPlan(file, { seed: { gbf_kj_times: FULL }, plan: { goalKind: 'number', goalText: '60億', meatText: '40000' }, errors });
    const res = await T(a.page, '[data-resbody]');
    ok(res.includes('200HELL・1周 0.384% で計算') && res.includes('150HELL・1周 0.336%'), 'A1: 結果に、使った難易度と確率（「200HELL・1周 0.384% で計算」）が出る', res.slice(0, 700));
    await a.ctx.close();
    const b = await openPlan(file, { seed: { gbf_kj_times: FULL, gbf_kj_trehun: { diff: 'h100', boxBase: 3, itemRate: 4 } }, plan: { goalKind: 'number', goalText: '60億', meatText: '40000' }, errors });
    const res2 = await T(b.page, '[data-resbody]');
    ok(res2.includes('200HELL・1周 0.192% で計算') && res2.includes('150HELL・1周 0.168%'), 'A1: トレハンタブの設定を変えると（アイテム率 4%）、使った難易度と確率も変わる（200HELL → 0.192%）', res2.slice(0, 700));
    await b.ctx.close();
  }

  // ---- A2：肉が足りないとき・肉が未入力のとき・目標を決めないとき ----
  {
    const cardInfo = (page) => page.evaluate(() => {
      const cards = [...document.querySelectorAll('[data-resbody] .pl-card')].map((c) => c.innerText.replace(/\s+/g, ' ').trim());
      return { cards, meat: cards.reduce((a, c) => { const m = c.match(/肉 ([\d,]+)/); return a + (m ? parseInt(m[1].replace(/,/g, ''), 10) : 0); }, 0), idle: cards.filter((c) => /余裕/.test(c)).length };
    });
    const a = await openPlan(file, { seed: { gbf_kj_times: FULL }, plan: { goalKind: 'number', goalText: '60億', meatText: '3000' }, errors });
    const short = await cardInfo(a.page);
    ok(short.meat <= 3000 && short.meat > 0, `A2: 肉が足りないとき、カードの肉の合計（${short.meat}）が、いまの肉（3,000）以下`, short.cards.join(' | '));
    ok(await a.page.evaluate(() => planPanel.R.views.time.minMeat === false && planPanel.R.views.time.shortage.meat > 0), 'A2: 肉が足りないとき、カードは「いまの肉で取れるだけ取る計画」（肉が最小の計画ではない）');
    await a.ctx.close();
    const m = await openPlan(file, { seed: { gbf_kj_times: FULL }, plan: { goalKind: 'number', goalText: '60億', meatText: '3500', matText: '2000' }, errors });
    const withMat = await cardInfo(m.page);
    ok(withMat.meat === 4200 && await m.page.evaluate(() => planPanel.R.views.time.minMeat === true && planPanel.R.views.time.shortage.meat === 0), `A2: 素材の変換で肉が足りるとき（肉 3,500 + 素材 2,000）、カードの肉の合計（${withMat.meat}）は「必要な通常肉」（4,200）と一致する`, withMat.cards.join(' | '));
    await m.ctx.close();
    const b = await openPlan(file, { seed: { gbf_kj_times: FULL }, plan: { goalKind: 'number', goalText: '60億' }, errors });
    const unk = await cardInfo(b.page);
    ok(unk.meat === 4200, `A2: 肉が未入力のとき、カードの肉の合計（${unk.meat}）は、必要な通常肉（4,200）`, unk.cards.join(' | '));
    await b.ctx.close();
    const c = await openPlan(file, { seed: { gbf_kj_times: FULL }, plan: { goalKind: 'none', meatText: '40000', normalHours: '4' }, errors });
    const fwd = await cardInfo(c.page);
    ok(fwd.cards.length === 4 && fwd.idle === 0, 'A2: 目標を決めないとき（貢献度の最大化）は、「余裕」を出さない（表示は変えない）', fwd.cards.join(' | '));
    await c.ctx.close();
  }

  // ---- 日ごとの ○△× ----
  {
    const { ctx, page } = await openPlan(file, { seed: { gbf_kj_times: FULL }, plan: { goalKind: 'number', goalText: '60億', meatText: '40000' }, errors });
    await page.click('[data-res] [data-mark="t"][data-day="d2"]'); await page.click('[data-res] [data-mark="x"][data-day="d3"]');
    const res = await T(page, '[data-resbody]');
    ok(res.includes('自動の日（本戦1日目・本戦4日目）は 約 13時間51分ずつで、届きます') && res.includes('必要な通常肉 6,280個'), '○△×: 2日目△（3時間）・3日目×で組み直す → 自動の日（1日目・4日目）は 約 13時間51分', res);
    const cards = await page.evaluate(() => [...document.querySelectorAll('[data-res] .pl-card')].map((c) => c.innerText.replace(/\s+/g, ' ').trim()));
    ok(cards[1].includes('3時間') && !cards[1].includes('（自動）') && cards[2].includes('走らない') && cards[0].includes('13時間51分（自動）'), '日ごとのカード: △の日は 3時間（固定）、×の日は「走らない」、○の日は自動', cards.join(' | '));
    ok((await T(page, '[data-summ="days"]')) === '○△×○', '⑤ 走れる日: 要約が ○△×○ になる');
    await openStep(page, 'days');
    ok(await page.evaluate(() => ['d2:t', 'd3:x', 'd1:o'].every((x) => document.querySelector(`[data-daylist] [data-day="${x.split(':')[0]}"][data-mark="${x.split(':')[1]}"]`).classList.contains('on'))), '⑤ 走れる日: 選んだ ○△× が、ここにも反映される');
    // 細かい時間
    await page.check('[data-f="detail"]');
    await page.fill('[data-hours="d1"]', '2');
    const res2 = await T(page, '[data-resbody]');
    ok((await page.evaluate(() => [...document.querySelectorAll('[data-res] .pl-card')][0].innerText.replace(/\s+/g, ' '))).includes('2時間') && res2.includes('自動の日（本戦4日目）は'), '細かい時間: 1日目に「2時間」を入れると、固定になり、自動の日は 4日目だけ', res2);
    await page.fill('[data-f="triHours"]', '5');
    ok((await page.evaluate(() => [...document.querySelectorAll('[data-res] .pl-card')][1].innerText.replace(/\s+/g, ' '))).includes('5時間'), '△の日の時間を 5時間にすると、2日目が 5時間になる');
    await ctx.close();
  }

  // ---- 今の状況（本戦2日目・今 20億） ----
  {
    const { ctx, page } = await openPlan(file, { seed: { gbf_kj_times: FULL }, plan: { goalKind: 'number', goalText: '60億', where: 'd2', curText: '20億', meatText: '30000' }, errors });
    const res = await T(page, '[data-resbody]');
    const cards = await page.evaluate(() => [...document.querySelectorAll('[data-res] .pl-card')].map((c) => c.innerText.replace(/\s+/g, ' ').trim()));
    ok(res.includes('毎日 約 4時間48分ずつで、届きます') && res.includes('必要な通常肉 1,200個') && cards[0].includes('終わりました') && !cards[0].includes('○'), '今の状況: 本戦2日目・今20億 → 終わった1日目は計画に入れず、残りは 毎日 約 4時間48分', res);
    ok((await T(page, '[data-summ="now"]')) === '本戦2日目・肉 30,000' && res.includes('本戦2日目終了時：31.44億') && !res.includes('本戦1日目終了時'), '各日の終了時の目安は、今日から（今の貢献度 20億を含めて）', res);
    await openStep(page, 'days');
    ok((await T(page, '[data-dayrow="d1"]')).includes('終わりました') && (await T(page, '[data-dayrow="d2"]')).includes('（今日）'), '⑤: 終わった日と今日が分かる');
    await ctx.close();
  }

  // ---- 目標：順位から選ぶ／決めない ----
  {
    const { ctx, page } = await openPlan(file, { seed: { gbf_kj_times: FULL, gbf_kj_border: BORDER }, plan: { goalKind: 'rank', goalRank: 100000, meatText: '40000' }, errors });
    const opts = await page.evaluate(() => [...document.querySelectorAll('[data-rank] option')].map((o) => o.textContent));
    ok(opts.join('|') === '2000位（最終予想 1,500億）|10万位（現在 95億）', '目標: 順位の選択肢は、ボーダータブの値（最終予想があればそれ）', opts.join('|'));
    ok((await T(page, '[data-rankinfo]')).includes('10万位の現在のボーダー：95億') && (await T(page, '[data-summ="goal"]')) === '95億', '目標: 10万位 → 95億（現在のボーダー）', await T(page, '[data-rankinfo]'));
    await page.selectOption('[data-rank]', '2000');
    const res = await T(page, '[data-resbody]');
    ok((await T(page, '[data-summ="goal"]')) === '1,500億' && res.includes('17時間ずつ（1日の上限）でも、届きません') && res.includes('順位の目安：約 4.9万位'), '目標: 2000位（1,500億）を選ぶと、17時間でも届かない。いまの条件で届く貢献度と、順位の目安が出る', res);
    await ctx.close();
    const n = await openPlan(file, { seed: { gbf_kj_times: FULL }, plan: { goalKind: 'rank', goalRank: 2000, meatText: '40000' }, errors });
    ok((await T(n.page, '[data-resbody]')).includes('選んだ順位のボーダーがありません') && (await T(n.page, '[data-rankinfo]')).includes('ボーダータブに値がありません'), '目標: ボーダーの値がないときは、案内');
    await n.ctx.close();
  }
  {
    const { ctx, page } = await openPlan(file, { seed: { gbf_kj_times: FULL, gbf_kj_border: BORDER }, plan: { goalKind: 'none', meatText: '40000', normalHours: '4' }, errors });
    const res = await T(page, '[data-resbody]');
    ok(res.includes('この条件だと、貢献度 約 36.88億（順位の目安：10万位より下）') && res.includes('使う時間は、合計 16時間') && res.includes('使う通常肉 2,560個・250専用素材 640個'), '決めない: ○の日 4時間で、どこまで行けるか（貢献度・順位の目安・使う肉と素材）', res);
    await page.evaluate(() => { document.querySelector('[data-head="days"]').click(); });
    await page.fill('[data-f="normalHours"]', '8');
    ok((await T(page, '[data-resbody]')).includes('貢献度 約 73.76億'), '決めない: ○の日の時間を 8時間にすると、見込みが増える', await T(page, '[data-resbody]'));
    await ctx.close();
    const m = await openPlan(file, { seed: {}, plan: { goalKind: 'none' }, errors });
    ok((await T(m.page, '[data-resbody]')).includes('④で討伐タイムを1つでも入れると'), '決めない・タイムなし: 案内');
    await m.ctx.close();
    const e = await openPlan(file, { seed: { gbf_kj_times: FULL }, plan: { goalKind: 'number', goalText: 'あいう' }, errors });
    ok((await T(e.page, '[data-resbody]')).includes('目標を読み取れません') && (await T(e.page, '[data-echo="goal"]')) === '読み取れません', '目標: 読めない入力は知らせる');
    await e.ctx.close();
  }

  // ---- 討伐タイム ----
  {
    const { ctx, page } = await openPlan(file, { seed: {}, plan: { goalKind: 'number', goalText: '60億', meatText: '40000' }, errors });
    const res = await T(page, '[data-resbody]');
    const rows = await page.evaluate(() => [...document.querySelectorAll('[data-res] tbody tr')].map((r) => r.innerText.replace(/\s+/g, ' ').trim()));
    ok(res.includes('討伐タイムがないので、各難易度だけで回したとき') && rows.length === 6 && rows[5].startsWith('250HELL 80回') && rows[4].startsWith('200HELL 300回 ― 6,000個') && rows[3].startsWith('150HELL 1,464回'), 'タイムなし: 各難易度だけで回したときの、回数と肉の目安（60億 → 250HELL 80回・200HELL 300回）', rows.join(' | '));
    ok((await T(page, '[data-sum]')).includes('目標まで あと 60億。④で討伐タイムを入れると'), 'タイムなし: 要約の帯にも案内');
    // しっかり入力 → 討伐効率タブと同じ保存に入る
    await openStep(page, 'time');
    await page.fill('[data-tf="h150"][data-part="min"]', '3'); await page.fill('[data-tf="h200"][data-part="min"]', '5'); await page.fill('[data-tf="h250"][data-part="min"]', '15');
    const kt = await page.evaluate(() => JSON.parse(localStorage.getItem('gbf_kj_times')));
    ok(kt.h150 === 180 && kt.h200 === 300 && kt.h250 === 900, 'しっかり入力: 討伐効率タブと同じ保存（gbf_kj_times）に入る', JSON.stringify(kt));
    ok(await page.evaluate(() => document.querySelector('#eff-tbody .time-sel-min[data-id="h150"]').value === '3' && document.querySelector('#eff-tbody .time-sel-min[data-id="h250"]').value === '15'), '討伐効率タブの表にも、反映される');
    ok((await T(page, '[data-resbody]')).includes('毎日 約 6時間') && (await T(page, '[data-summ="time"]')) === '3つ入力', 'タイムを入れると、毎日の時間と肉の計画が出る（3つだけでも）', await T(page, '[data-resbody]'));
    await page.fill('[data-tf="h250"][data-part="min"]', '');
    ok((await page.evaluate(() => JSON.parse(localStorage.getItem('gbf_kj_times')).h250)) === undefined, 'しっかり入力: 空にすると、その難易度は未入力に戻る');
    await ctx.close();
  }
  {
    const { ctx, page } = await openPlan(file, { seed: {}, plan: { goalKind: 'number', goalText: '40億', meatText: '40000', timeMode: 'one', oneId: 'h150', oneMin: '3', oneSec: '', open: 'time' }, errors });
    const res = await T(page, '[data-resbody]');
    ok((await T(page, '[data-onelist]')).includes('推定した時間：200HELL 14分38秒・250HELL 54分53秒。基準より下の難易度は、使いません。') && (await T(page, '[data-summ="time"]')) === '1つ入力＋推定2つ', '1つだけ入力: 150HELL 3分 → 200HELL・250HELL を同じ効率で推定（下の難易度は使わない）', await T(page, '[data-onelist]'));
    ok(res.includes('毎日 約 12時間12分ずつで、届きます') && res.includes('必要な通常肉 6,080個'), '1つだけ入力: 40億 → 毎日 12時間12分・必要な肉 6,080個（スケジュールタブの「同じ効率で推定」と同じ）', res);
    ok(!(await page.evaluate(() => JSON.parse(localStorage.getItem('gbf_kj_times') || '{}').h150)), '1つだけ入力: 討伐効率タブの時間は、変えない');
    await ctx.close();
  }
  {
    const { ctx, page } = await openPlan(file, { seed: {}, plan: { goalKind: 'number', goalText: '60億', meatText: '40000', timeMode: 'rough', rough: { h150: { min: '5', runs: '28' }, h200: { min: '', runs: '12' }, h250: { min: '30', runs: '2' } }, open: 'time' }, errors });
    ok((await T(page, '[data-roughcalc="h150"]')) === '＝ 1回 約 11秒' && (await T(page, '[data-roughcalc="h200"]')) === '＝ 1回 約 25秒' && (await T(page, '[data-roughcalc="h250"]')) === '＝ 1回 約 15分', 'ざっくり: 「5分で28回」→ 1回 約11秒。分が空なら 5分（250HELL は 30分）として計算', [await T(page, '[data-roughcalc="h150"]'), await T(page, '[data-roughcalc="h200"]'), await T(page, '[data-roughcalc="h250"]')].join(' / '));
    ok((await T(page, '[data-resbody]')).includes('毎日 約 39分ずつで、届きます') && (await T(page, '[data-summ="time"]')) === '3つ入力', 'ざっくり: 計算に使われて、計画が出る', await T(page, '[data-resbody]'));
    ok(!(await page.evaluate(() => localStorage.getItem('gbf_kj_times'))), 'ざっくり: 討伐効率タブの時間は、変えない');
    await ctx.close();
  }

  // ---- 極星器（B1〜B3） ----
  {
    const a = await openPlan(file, { seed: { gbf_kj_times: FULL }, plan: { goalKind: 'number', goalText: '60億', meatText: '40000', open: 'star' }, errors });
    // B1：③に、難易度ごとの確率が出る。トレハンタブで同じ難易度を選んだときの表示と、一致する
    const info = await T(a.page, '[data-starinfo]');
    ok(info.includes('90HELL 0.192%') && info.includes('150HELL 0.336%') && info.includes('200HELL 0.384%') && info.includes('250HELL は、確率がわからない'), 'B1: ③に、難易度ごとの1周の確率（トレハンタブの設定）が出る。250HELL は確率不明', info);
    const cmp = await a.page.evaluate(() => {
      const ids = ['h90', 'h95', 'h100', 'h150', 'h200'], out = [];
      for (const id of ids) {
        const sel = document.querySelector('#trehun-panel [data-diff]');
        sel.value = id; sel.dispatchEvent(new Event('change', { bubbles: true }));                           // トレハンタブで、難易度を選ぶ
        const shown = parseFloat(document.querySelector('#trehun-panel .th-big').innerText.match(/アイテム\s*([\d.]+)%/)[1]);
        const mine = TrehunPanel.perDiff(trehunPanel.state, HELL_DIFFS.map((d) => d.id))[id].item;
        out.push({ id, shown, mine: Math.round(mine * 10000) / 10000 });
      }
      return out;
    });
    ok(cmp.every((c) => c.shown === c.mine), 'B1: 各難易度の確率が、トレハンタブで同じ難易度を選んだときの表示と一致する', JSON.stringify(cmp));
    await a.page.evaluate(() => { const sel = document.querySelector('#trehun-panel [data-diff]'); sel.value = 'h200'; sel.dispatchEvent(new Event('change', { bubbles: true })); });
    // 「集めない」（既定）：本数の目安だけ
    await a.page.click('.tab-btn[data-tab="plan"]');
    ok(await a.page.evaluate(() => document.querySelector('[data-box="star-yes"]').hidden) && (await T(a.page, '[data-state="star"]')) === '初期値', 'B3: ③は「たくさん集める？」で始まり、既定は「集めない」（本数の入力は出ない）');
    const r0 = await T(a.page, '[data-resbody]');
    ok(/極星器：この計画の周回で、期待 約 [\d.]+本（90%の確率で \d+本以上）落ちます/.test(r0) && !r0.includes('追加で'), 'B2: 欲しい本数を入れなくても、結果に、期待本数と「90%で ◯本以上」が出る', r0.slice(0, 700));
    // 「集める」
    await a.page.click('[data-seg="starCollect"] [data-v="yes"]');
    ok(!(await a.page.evaluate(() => document.querySelector('[data-box="star-yes"]').hidden)), 'B3: 「集める」を選ぶと、欲しい本数・見積り・追加で回す難易度が出る');
    await a.page.fill('[data-f="starText"]', '3');
    const r3 = await T(a.page, '[data-resbody]');
    ok(r3.includes('計画どおりだと期待 約') && r3.includes('3本</b>欲しいなら') || /3本欲しいなら、追加で/.test(r3), 'B3: 「計画どおりだと期待 ◯本 → ◯本欲しいなら、追加で ◯HELL を ◯回（毎日 +◯分、肉 +◯個）」の形で出る', r3.slice(0, 900));
    ok(/毎日 \+\d/.test(r3) && /肉 \+\d/.test(r3), 'B3: 追加の周回で増える時間（毎日 +◯分）と肉（+◯個）が出る', r3.slice(0, 900));
    const v3 = await a.page.evaluate(() => { const v = planPanel.R.views.time; return { mean: v.stars.mean, hours: v.autoHours, days: v.days.map((d) => d.hours), base: v.base.autoHours }; });
    ok(v3.mean >= 3 - 1e-9 && v3.days.every((h) => h <= 17 + 1e-9) && v3.hours > v3.base, `B3: 計画の期待本数は 3本以上（${v3.mean.toFixed(2)}）。どの日も 17時間を超えない。時間は、極星器なしより増える（${v3.base}h → ${v3.hours}h）`, JSON.stringify(v3));
    ok(!r3.includes('1日 17時間を超えます') && !r3.includes('1日 17時間（本戦の1日に遊べる上限）を超えます') && !r3.includes('＋極星器の周回'), 'B3: 周回の別枠（starPlacement）と、17時間を超える警告は、なくなった');
    // 追加で回す難易度を指定
    await a.page.selectOption('[data-f="starDiff"]', 'h90');
    const r90 = await T(a.page, '[data-resbody]');
    ok(/追加で 90HELL を [\d,]+回/.test(r90), 'B3: 追加で回す難易度に 90HELL を選ぶと、「追加で 90HELL を ◯回」と出る', r90.slice(0, 900));
    ok(await a.page.evaluate(() => [...document.querySelector('[data-f="starDiff"]').options].find((o) => o.value === 'h250').disabled), 'B3: 確率不明の難易度（250HELL）は、追加で回す難易度に選べない');
    // 90% の確率で届くように
    await a.page.fill('[data-f="starText"]', '1');
    await a.page.selectOption('[data-f="starMode"]', 'p90');
    const r1 = await T(a.page, '[data-resbody]');
    ok(r1.includes('90%以上になるように、平均の目標を上げて解き直しています'), 'B3: 90%の確率で届くように見積もると、確率を計算して、平均の目標を上げて解き直す', r1.slice(0, 900));
    ok(await a.page.evaluate(() => planPanel.R.views.time.stars.pAtLeast >= 0.9 - 1e-9), 'B3: そのとき、1本以上になる確率は 90% 以上');
    // 集められない本数
    await a.page.selectOption('[data-f="starMode"]', 'avg');
    await a.page.fill('[data-f="starText"]', '40');
    ok((await T(a.page, '[data-resbody]')).includes('集められません'), 'B3: 1日 17時間でも集められない本数は、そう伝える');
    // 保存：開き直しても、残る
    await a.page.fill('[data-f="starText"]', '2');
    await a.page.reload();
    ok(await a.page.evaluate(() => planPanel.state.starCollect === 'yes' && planPanel.state.starText === '2' && planPanel.state.starDiff === 'h90' && planPanel.state.starMode === 'avg'), 'B3: 「集める」・本数・追加で回す難易度は、保存されて、開き直しても残る');
    await a.ctx.close();
    // 古い保存（欲しい本数が入っていた）は、「集める」にする
    const old = await openPlan(file, { seed: { gbf_kj_times: FULL }, plan: { goalKind: 'number', goalText: '60億', meatText: '40000', starText: '2' }, errors });
    ok(await old.page.evaluate(() => planPanel.state.starCollect === 'yes'), 'B3: 古い保存（欲しい本数が入っている）は、「集める」として読み込む');
    await old.ctx.close();
    // 目標を決めないとき
    const f = await openPlan(file, { seed: { gbf_kj_times: FULL }, plan: { goalKind: 'none', meatText: '40000', normalHours: '17', starCollect: 'yes', starText: '2' }, errors });
    const rf = await T(f.page, '[data-resbody]');
    ok(/極星器：この計画の周回で、期待 約 [\d.]+本/.test(rf), 'B2: 目標を決めないときも、極星器の見込みが出る', rf.slice(0, 600));
    await f.ctx.close();
    // 討伐タイムがないとき（回数の表）
    const z = await openPlan(file, { seed: {}, plan: { goalKind: 'number', goalText: '150億' }, errors });
    const rz = await T(z.page, '[data-resbody]');
    ok(rz.includes('極星器（期待）') && rz.includes('250HELL 200回') && rz.includes('200HELL 750回') && rz.includes('約 2.88本') && rz.includes('確率不明'), 'B2: 討伐タイムがないとき、回数の表に、各難易度だけで回したときの極星器の本数の列が出る（250HELL は確率不明）', rz.slice(0, 600));
    await z.ctx.close();
  }

  // ---- 肉が足りないとき ----
  {
    const { ctx, page } = await openPlan(file, { seed: { gbf_kj_times: FULL }, plan: { goalKind: 'number', goalText: '60億', meatText: '300', gatherMin: '10', gatherMeat: '70' }, errors });
    const res = await T(page, '[data-resbody]');
    ok(res.includes('いま 300個 → あと 3,900個 足りません（200HELL なら約 195回ぶん）') && res.includes('肉集めが「10分で 70個」なら、あと 約 9時間17分 集めると足ります'), '肉不足: あと 3,900個（200HELL 195回ぶん）。10分で70個なら、あと 約9時間17分集める', res);
    ok(res.includes('肉が足りれば、毎日 約 6時間33分で届きます（いまは 約 9時間30分）') && res.includes('合計 約 11時間48分 節約できます') && res.includes('集める価値があります'), '肉不足: 肉が足りれば毎日 6時間33分。集める時間（9時間17分）より、節約できる時間（11時間48分）が長いので、集める価値がある', res);
    ok((await T(page, '[data-sum]')).includes('（あと 3,900個）'), '肉不足: 要約の帯にも、あと何個かが出る');
    await page.evaluate(() => document.querySelector('[data-head="now"]').click());
    await page.fill('[data-f="collectText"]', '3900');
    const res2 = await T(page, '[data-resbody]');
    ok(res2.includes('毎日 約 6時間33分ずつで、届きます') && res2.includes('いま 4,200個で足ります'), '肉不足: 「集める予定の肉」に入れると、足りて、計画に反映される', res2);
    await ctx.close();
    const n = await openPlan(file, { seed: { gbf_kj_times: FULL }, plan: { goalKind: 'number', goalText: '60億', meatText: '300' }, errors });
    ok((await T(n.page, '[data-resbody]')).includes('④で「◯分で肉◯個」を入れると、あと何時間集めればよいかも出ます'), '肉不足: 肉集めの速さがなければ、入れるよう案内');
    await n.ctx.close();
    const u = await openPlan(file, { seed: { gbf_kj_times: FULL }, plan: { goalKind: 'number', goalText: '60億' }, errors });
    ok((await T(u.page, '[data-resbody]')).includes('通常肉が未入力なので、足りるかどうかは出していません') && (await T(u.page, '[data-resbody]')).includes('必要な通常肉 4,200個') && (await T(u.page, '[data-resbody]')).includes('いまの肉が未入力'), '肉が未入力: 必要な数だけ出して、足りるかは出さない');
    await u.ctx.close();
    const m = await openPlan(file, { seed: { gbf_kj_times: FULL }, plan: { goalKind: 'number', goalText: '60億', meatText: '40000', matText: '100' }, errors });
    const rm = await T(m.page, '[data-resbody]');
    ok(rm.includes('いま 100個 → あと 940個 足りません'), '250専用素材: 100個だと、あと 940個。入れたときは、素材の数も考えて計画する', rm);
    await m.ctx.close();
  }

  // ---- 保存・取り込み・スキップ ----
  {
    const { ctx, page } = await openPlan(file, { seed: { gbf_kj_times: FULL }, errors });
    await page.fill('#pl-goal', '60億'); await page.click('[data-next="goal"]');
    await page.fill('[data-f="meatText"]', '40000');
    await page.click('[data-seg="where"] [data-v="d3"]');
    await page.click('[data-skip="now"]');
    ok(!(await page.evaluate(() => document.querySelector('[data-body="star"]').hidden)) && (await T(page, '[data-state="star"]')) === '初期値', '「スキップ」で、次へ進む（飛ばした所は、そのまま）');
    await page.click('[data-skip="star"]');
    ok((await T(page, '[data-state="star"]')) === 'スキップ', 'スキップした所は「スキップ」と表示される');
    await page.click('[data-res] [data-mark="t"][data-day="d4"]');
    await page.reload();
    const st = await page.evaluate(() => ({ goal: planPanel.state.goalText, where: planPanel.state.where, mark: planPanel.state.marks.d4, skip: planPanel.state.skipped.star }));
    ok(st.goal === '60億' && st.where === 'd3' && st.mark === 't' && st.skip === true && (await page.inputValue('#pl-goal')) === '60億', '保存: 開き直しても、入れた内容・今の状況・○△×・スキップが残る', JSON.stringify(st));
    const r1 = await T(page, '[data-resbody]');
    ok(r1.includes('本戦1日目 終わりました') || r1.includes('終わりました'), '保存: 開き直しても、同じ結果が出る');
    await ctx.close();
    const a = await openPlan(file, { seed: { gbf_kj_times: FULL, gbf_kj_inputs: { 't-goal': '50億', 't-cur': '10億', 'm-normal': '12000', 'm-mat': '500' } }, errors });
    const as = await a.page.evaluate(() => ({ goal: planPanel.state.goalText, cur: planPanel.state.curText, meat: planPanel.state.meatText, mat: planPanel.state.matText }));
    ok(as.goal === '50億' && as.cur === '10億' && as.meat === '12000' && as.mat === '500', 'はじめて開いたとき: ほかのタブに入っている目標・貢献度・肉・素材を、取り込む', JSON.stringify(as));
    await a.ctx.close();
  }

  // ---- 閉じた状態・初期値・最初からやり直す ----
  {
    const { ctx, page } = await openPlan(file, { seed: { gbf_kj_times: FULL }, plan: { goalKind: 'number', goalText: '60億', meatText: '40000', open: '' }, errors });
    ok(await page.evaluate(() => ['goal', 'now', 'star', 'time', 'days'].every((id) => document.querySelector(`[data-body="${id}"]`).hidden)), '全部閉じた状態も、保存される（開き直しても、閉じたまま）');
    ok((await T(page, '[data-state="days"]')) === '初期値' && (await T(page, '[data-state="now"]')) === '入力済み', '⑤ 走れる日: 何も変えていないときは「初期値」');
    await page.click('[data-res] [data-mark="x"][data-day="d1"]');
    ok((await T(page, '[data-state="days"]')) === '入力済み', '⑤ 走れる日: ○△×を変えると「入力済み」');
    page.once('dialog', (d) => d.accept());
    await page.click('[data-reset]');
    const st = await page.evaluate(() => ({ goal: planPanel.state.goalText, meat: planPanel.state.meatText, mark: planPanel.state.marks.d1, times: JSON.parse(localStorage.getItem('gbf_kj_times')).h150, saved: JSON.parse(localStorage.getItem('gbf_kj_plan')).goalText }));
    ok(st.goal === '' && st.meat === '' && st.mark === 'o' && st.times === 180 && st.saved === '' && (await page.inputValue('#pl-goal')) === '', '最初からやり直す: 入れた内容を消す（討伐効率タブの討伐時間は、残る）', JSON.stringify(st));
    await ctx.close();
    const c = await openPlan(file, { seed: { gbf_kj_times: FULL }, plan: { goalKind: 'number', goalText: '60億', meatText: '40000' }, errors });
    c.page.once('dialog', (d) => d.dismiss());
    await c.page.click('[data-reset]');
    ok((await c.page.evaluate(() => planPanel.state.goalText)) === '60億', '最初からやり直す: 確認で「キャンセル」すれば、消さない');
    await c.ctx.close();
  }

  // ---- 保存された値が、おかしくても（書き換えられても）壊れない ----
  {
    const bad = { goalKind: 'zzz', where: 'd9', timeMode: 'x', tab: 'y', starMode: 'q', starCollect: 'zzz', starDiff: 'nope', oneId: 'nope', goalRank: 'a', open: 'ほげ', goalText: '60億', meatText: '300', gatherMin: '10', gatherMeat: '<img src=x onerror=window.__xss=1>70', marks: { d1: 'z', d2: 't' }, hours: { d1: 5 }, rough: { h150: 3 }, skipped: { goal: 'yes' } };
    const { ctx, page } = await openPlan(file, { seed: { gbf_kj_times: FULL }, plan: bad, errors });
    const st = await page.evaluate(() => ({ kind: planPanel.state.goalKind, where: planPanel.state.where, mode: planPanel.state.timeMode, tab: planPanel.state.tab, star: planPanel.state.starMode, collect: planPanel.state.starCollect, sdiff: planPanel.state.starDiff, one: planPanel.state.oneId, rank: planPanel.state.goalRank, open: planPanel.state.open, d1: planPanel.state.marks.d1, d2: planPanel.state.marks.d2, skip: planPanel.state.skipped.goal }));
    ok(st.kind === 'number' && st.where === 'pre' && st.mode === 'full' && st.tab === 'time' && st.star === 'avg' && st.collect === 'no' && st.sdiff === '' && st.one === 'h150' && st.rank === 0 && st.open === 'goal' && st.d1 === 'o' && st.d2 === 't' && st.skip === undefined, '壊れた保存: おかしな値は、初期値に戻る', JSON.stringify(st));
    const res = await T(page, '[data-resbody]');
    ok(res.includes('毎日 約') && !(await page.evaluate(() => document.querySelector('[data-res] img') || window.__xss)), '壊れた保存: 結果は出て、入れた文字列は HTML として動かない', res.slice(0, 200));
    await ctx.close();
    const g = await openPlan(file, { seed: { gbf_kj_times: FULL }, plan: { goalKind: 'number', goalText: '60億', meatText: '300', gatherMin: '10', gatherMeat: '<b id=inj>70</b>' }, errors });
    ok(!(await g.page.evaluate(() => document.getElementById('inj'))) && (await T(g.page, '[data-resbody]')).includes('④で「◯分で肉◯個」を入れると'), '肉集めの欄に、数でない文字列があっても、タグとして動かない（速さは、未入力として扱う）');
    await g.ctx.close();
    const j = await browser.newContext(); const jp = await j.newPage();
    await jp.route('**/*', (route) => (new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort()));
    await jp.addInitScript(() => { localStorage.setItem('gbf_kj_plan', '{こわれた'); });
    jp.on('pageerror', (e) => errors.push(String(e.message || e)));
    await jp.goto(`${base}/${file}#plan`);
    if (WORKER) await settle(jp);
    ok((await jp.evaluate(() => planPanel.state.goalKind)) === 'number' && (await jp.innerText('[data-resbody]')).includes('①で目標を入れてください'), '壊れた保存（JSON として読めない）: 初期の状態で開く');
    await j.close();
  }

  // ---- ほかのタブの値との違いを、案内する ----
  {
    const { ctx, page } = await openPlan(file, { seed: { gbf_kj_times: FULL, gbf_kj_inputs: { 't-goal': '80億', 'm-normal': '12000', 'm-mat': '500' } }, plan: { goalKind: 'number', goalText: '60億', meatText: '40000' }, errors });
    ok(!(await page.evaluate(() => document.querySelector('[data-importgoal]').hidden)) && (await T(page, '[data-importgoal]')).includes('目標計算タブには「80億」が入っています'), 'ほかのタブの値: 目標計算タブの目標が違うときは、案内を出す');
    await page.click('[data-import="goal"]');
    ok((await page.evaluate(() => planPanel.state.goalText)) === '80億' && (await page.inputValue('#pl-goal')) === '80億' && (await page.evaluate(() => document.querySelector('[data-importgoal]').hidden)), 'ほかのタブの値: 「これを使う」で、目標を取り込む（案内は消える）');
    await openStep(page, 'now');
    ok((await T(page, '[data-importnow]')).includes('通常肉 12,000個') && (await T(page, '[data-importnow]')).includes('250専用素材 500個'), 'ほかのタブの値: 肉計算タブの肉・素材が違うときも、案内を出す', await T(page, '[data-importnow]'));
    await page.click('[data-import="now"]');
    ok((await page.inputValue('[data-f="meatText"]')) === '12000' && (await page.inputValue('[data-f="matText"]')) === '500' && (await page.evaluate(() => document.querySelector('[data-importnow]').hidden)), 'ほかのタブの値: 取り込むと、肉・素材が入り、案内は消える');
    await ctx.close();
  }

  // ---- 計算の部品（単体） ----
  {
    const { ctx, page } = await openPlan(file, { seed: { gbf_kj_times: FULL }, errors });
    const u = await page.evaluate(() => {
      const P = PlanPanel;
      // 二項分布：別のやり方（周回ごとに、落ちた数の確率を更新）で、n個以上落ちる確率が 90% 以上になる最小の周回数
      const brute = (q, n) => { let dist = new Array(n + 1).fill(0); dist[0] = 1; for (let r = 1; r < 100000; r++) { const nd = new Array(n + 1).fill(0); for (let k = 0; k <= n; k++) { nd[k] += dist[k] * (1 - q) * (k < n ? 1 : 0); if (k < n) nd[k + 1] += dist[k] * q; else nd[n] += dist[n] * q; } nd[n] += dist[n] * (1 - q); dist = nd; if (dist[n] >= 0.9) return r; } return -1; };
      const cases = [[0.00384, 1], [0.00384, 3], [0.04, 5], [0.5, 4]].map(([q, n]) => ({ q, n, got: P.runsForCount(q, n, 0.9), want: brute(q, n) }));
      const pts = [{ rank: 2000, value: 150e9 }, { rank: 100000, value: 9.5e9 }];
      const rk = [200e9, 150e9, 40e9, 9.5e9, 5e9].map((v) => P.rankEstimate(v, pts));
      return { cases, rk, none: P.rankEstimate(1e9, []) };
    });
    ok(u.cases.every((c) => c.got === c.want), '極星器の周回数（90%）: 二項分布で、別の数え方と一致', JSON.stringify(u.cases));
    ok(u.rk[0].text === '2,000位以内' && u.rk[1].text === '2,000位以内' && u.rk[3].text.startsWith('約 10万位') && u.rk[4].text === '10万位より下' && u.rk[2].rank > 2000 && u.rk[2].rank < 100000 && u.none === null, '順位の目安: ボーダーの点のあいだを、対数で結ぶ。上回れば「以内」、下回れば「より下」', JSON.stringify(u.rk));
    const h = await page.evaluate(() => {
      const W = { ...PlanPanel.DEFAULTS, where: 'd2', marks: { d1: 'o', d2: 't', d3: 'x', d4: 'o' }, hours: { d1: '', d2: '', d3: '', d4: '7' }, detail: false, triHours: '2.5', normalHours: '6' };
      const days = PlanPanel.dayStates(W);
      const a = PlanPanel.hoursOptFrom(W, true, days).hours, b = PlanPanel.hoursOptFrom(W, false, days).hours, c = PlanPanel.hoursOptFrom({ ...W, detail: true }, true, days).hours;
      return { a, b, c };
    });
    ok(JSON.stringify(h.a) === JSON.stringify({ q: null, d1: 0, d2: 2.5, d3: 0, d4: null }) && h.b.d4 === 6 && h.c.d4 === 7 && h.c.d1 === 0, '日ごとの時間: 終わった日は 0、△は設定の時間、×は 0、○は自動（目標なしなら ふつうの日の時間）。細かい時間は、入れたとき（細かくするとき）だけ使う', JSON.stringify(h));
    await ctx.close();
  }

  // ---- スマホ幅・見た目 ----
  {
    const { ctx, page } = await openPlan(file, { w: 390, seed: { gbf_kj_times: FULL, gbf_kj_border: BORDER }, plan: { goalKind: 'number', goalText: '60億', meatText: '300', gatherMin: '10', gatherMeat: '70', open: 'now' }, errors });
    const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const sticky = await page.evaluate(() => getComputedStyle(document.querySelector('[data-sum]')).position);
    ok(ov <= 0 && sticky === 'static', `スマホ幅: 横にはみ出さない（${ov}px）。要約の帯は、固定しない`, `${ov} ${sticky}`);
    ok(await page.evaluate(() => [...document.querySelectorAll('.pl-card, .pl-box, .pl-row')].every((e) => e.scrollWidth <= e.clientWidth + 1)), 'スマホ幅: カード・欄が、はみ出さない');
    await shot(page, `${file}-plan-sp.png`);
    await ctx.close();
    const d = await openPlan(file, { w: 1100, seed: { gbf_kj_times: FULL }, plan: { goalKind: 'number', goalText: '60億', meatText: '40000' }, errors });
    ok(await d.page.evaluate(() => getComputedStyle(document.querySelector('[data-sum]')).position === 'sticky'), 'PC幅: 要約の帯は、画面の上に固定される');
    await d.ctx.close();
  }

  const real = errors.filter((e) => !/kofiWidgetOverlay/.test(e));
  ok(real.length === 0, `画面のエラーがない（${real.length}件）`, real.join(' | '));
}
await browser.close(); closeServer();
console.log(`\n${fails === 0 ? `全部 OK（${total}件）` : `${fails} 件 NG / ${total}件`}`);
process.exit(fails ? 1 : 0);
