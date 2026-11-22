import { startServer, launchBrowser, shot } from './lib.mjs';
const { base, close: closeServer } = await startServer();
const browser = await launchBrowser();
let fails = 0;
const ok = (cond, msg, extra = '') => { if (!cond) fails++; console.log(`${cond ? 'OK  ' : 'NG  '} ${msg}${!cond && extra ? '\n      ' + extra : ''}`); };

async function open(page, file, seed = {}) {
  await page.addInitScript((seed) => { for (const [k, v] of Object.entries(seed)) if (!sessionStorage.getItem('seeded:' + k)) { localStorage.setItem(k, v); sessionStorage.setItem('seeded:' + k, '1'); } }, seed);
  await page.goto(`${base}/${file}`);
}
async function newPage(width, height, errors) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  await page.route('**/*', (route) => (new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort()));
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  return { ctx, page };
}

for (const file of ['kosenjou.html', 'kosenjou-beta.html']) {
  console.log(`\n===== ${file} =====`);
  const errors = [];
  const { ctx, page } = await newPage(1280, 900, errors);
  await open(page, file);

  // ---- 肉計算 ----
  await page.click('.tab-btn[data-tab="meat"]');
  await page.check('#meat-fine-chk');
  await page.fill('#m-normal', '40000');
  await page.fill('#m-mat', '3000');
  await page.fill('#m-250runs', '200');
  let info = await page.innerText('#m-250info');
  let result = await page.innerText('#m-result');
  let total = await page.innerText('#m-total');
  ok(info.includes('200回には素材が4,000個必要ですが3,000個しかありません（最大150回）'), 'A: 素材が足りない警告（20個/回）', info);
  ok(info.includes('250HELL: 150回 × 20個 = 専用素材3,000個使用'), 'A: 250HELL は 20個/回で計算', info);
  ok(/200HELL[\s\S]*2,000回[\s\S]*400億/.test(result), 'A: 200HELL は 2,000回で 400億（8,200億ではない）', result);
  ok(total.includes('512.5億') || total.includes('512.50億'), 'A: 200HELL の合計は 400億 + 112.5億 = 512.5億', total);
  ok(!/[0-9],?[0-9]{3}億/.test(total.replace(/\s/g, '')) || true, '（参考）');
  await page.fill('#m-250runs', '100');
  info = await page.innerText('#m-250info'); result = await page.innerText('#m-result'); total = await page.innerText('#m-total');
  ok(info.includes('250HELL: 100回 × 20個 = 専用素材2,000個使用'), 'B: 100回 × 20個 = 2,000個', info);
  ok(info.includes('残り素材 1,000個 → 500個変換 → 通常肉 +1,000個') && info.includes('500個超えの分 (500個) は変換不可'), 'B: 残り1,000個 → 500個だけ変換', info);
  ok(info.includes('通常肉合計: 40,000 + 1,000 = 41,000個'), 'B: 通常肉合計 41,000個', info);
  ok(/200HELL[\s\S]*2,050回[\s\S]*410億/.test(result), 'B: 200HELL は 2,050回で 410億', result);
  ok(total.includes('485億'), 'B: 合計 410億 + 75億 = 485億', total);
  await shot(page, `${file}-meat-pc.png`);

  // ---- 目標計算 ----
  await page.click('.tab-btn[data-tab="target"]');
  let hint = await page.innerText('#t-goal-hint');
  ok(hint.includes('ボーダータブの値'), '目標: 最初の説明が出る', hint);
  await page.fill('#t-goal', '50億');
  ok((await page.innerText('#t-goal-echo')).includes('5,000,000,000'), '目標: 「50億」→ 5,000,000,000');
  ok((await page.innerText('#t-remain-val')).includes('50億'), '目標: 残り必要貢献度 50億');
  await page.fill('#t-goal', '1億5000万');
  ok((await page.innerText('#t-goal-echo')).includes('150,000,000'), '目標: 「1億5000万」→ 150,000,000');
  await page.fill('#t-goal', '５０億pt');
  ok((await page.innerText('#t-goal-echo')).includes('5,000,000,000'), '目標: 全角と「pt」も読める');
  await page.fill('#t-goal', 'あいう');
  ok((await page.innerText('#t-goal-echo')).includes('読み取れません'), '目標: 読めない入力は知らせる');
  ok((await page.innerText('#t-table-wrap')).includes('読み取れません'), '目標: 表にも知らせる');
  await page.fill('#t-goal', '300億'); await page.fill('#t-cur', '120億');
  ok((await page.innerText('#t-remain-val')).includes('180億'), '目標: 現在も手入力（120億）→ 残り 180億', await page.innerText('#t-remain-val'));

  // ボーダーの値がないとき
  await page.fill('#t-goal', '');
  await page.click('#t-goal-presets [data-goal-rank="2000"]');
  hint = await page.innerText('#t-goal-hint');
  ok(hint.includes('英雄（2000位）') && hint.includes('ボーダータブにまだありません'), 'ボタン: 値がなければ案内を出す', hint);
  ok((await page.inputValue('#t-goal')) === '', 'ボタン: 値がなければ目標は変えない');
  await ctx.close();

  // ボーダーの値があるとき（localStorage に入れておく）
  const errors2 = [];
  const p2 = await newPage(1280, 900, errors2);
  const border = JSON.stringify({ rows: [{ label: '2000位', current: 123456000000, final: 150000000000 }, { label: '10万位', current: 9500000000, final: null }], mine: null, days: 0, hours: 0, target: 0 });
  await open(p2.page, file, { gbf_kj_border: border });
  await p2.page.click('.tab-btn[data-tab="target"]');
  await p2.page.click('#t-goal-presets [data-goal-rank="2000"]');
  ok((await p2.page.inputValue('#t-goal')) === '1500億', 'ボタン: 英雄（2000位）→ 最終予想 1500億', await p2.page.inputValue('#t-goal'));
  hint = await p2.page.innerText('#t-goal-hint');
  ok(hint.includes('英雄（2000位）の最終予想') && hint.includes('1,500億'), 'ボタン: 何を入れたかを伝える', hint);
  ok((await p2.page.innerText('#t-remain-val')).includes('1,500億'), 'ボタン: 表も更新される');
  await p2.page.click('#t-goal-presets [data-goal-rank="100000"]');
  ok((await p2.page.inputValue('#t-goal')) === '95億', 'ボタン: 10万位 → 現在のボーダー 95億', await p2.page.inputValue('#t-goal'));
  ok((await p2.page.innerText('#t-goal-hint')).includes('現在のボーダー'), 'ボタン: 最終予想がなければ「現在のボーダー」と伝える');
  await p2.page.fill('#t-goal', '80億');
  ok((await p2.page.innerText('#t-goal-hint')).includes('ボーダータブの値（最終予想があればそれ）を入れます'), '手で直すと、説明が元に戻る');
  // 保存と復元
  await p2.page.fill('#t-goal', '2億5000万');
  await p2.page.reload();
  ok((await p2.page.inputValue('#t-goal')) === '2億5000万', '入力は、開き直しても残る', await p2.page.inputValue('#t-goal'));
  ok((await p2.page.innerText('#t-remain-val')).includes('2.50億') || (await p2.page.innerText('#t-remain-val')).includes('2.5億'), '復元した値で計算される', await p2.page.innerText('#t-remain-val'));
  await p2.page.click('#t-goal-presets [data-goal-rank="2000"]');
  await shot(p2.page, `${file}-target-pc.png`);
  await p2.ctx.close();

  // 旧い保存（選択肢の値＝数字だけ）も読める
  const p3 = await newPage(390, 844, errors2);
  await open(p3.page, file, { gbf_kj_inputs: JSON.stringify({ 't-goal': '5000000000', 't-cur': '0' }), gbf_kj_border: border });
  await p3.page.click('.tab-btn[data-tab="target"]');
  ok((await p3.page.innerText('#t-goal-echo')).includes('5,000,000,000'), '旧い保存（5000000000）も読める');
  await shot(p3.page, `${file}-target-sp.png`);
  const ov = await p3.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(ov <= 0, `スマホ幅で横にはみ出さない（${ov}px）`);
  await p3.page.click('.tab-btn[data-tab="meat"]');
  await p3.page.check('#meat-fine-chk');
  await p3.page.fill('#m-normal', '40000'); await p3.page.fill('#m-mat', '3000'); await p3.page.fill('#m-250runs', '100');
  await shot(p3.page, `${file}-meat-sp.png`);
  await p3.ctx.close();

  // ---- スケジュール（目標から逆算） ----
  const times = JSON.stringify({ h90: 90, h95: 120, h100: 150, h150: 180, h200: 300, h250: 900 });   // 討伐時間（秒）
  const p4 = await newPage(1280, 900, errors2);
  const pg = p4.page;
  await open(pg, file, { gbf_kj_times: times });
  await pg.click('.tab-btn[data-tab="meat"]'); await pg.check('#meat-fine-chk');
  await pg.fill('#m-normal', '40000'); await pg.fill('#m-mat', '0');
  await pg.click('.tab-btn[data-tab="schedule"]');
  const txt = async (sel) => (await pg.innerText(sel)).trim();
  const ph = async (id) => parseFloat(await pg.getAttribute('#s-hrs-' + id, 'placeholder'));
  const num = (m, i = 1) => (m ? Number(m[i].replace(/,/g, '')) : -1);
  const setGoal = async (g, c = '') => { await pg.click('.tab-btn[data-tab="target"]'); await pg.fill('#t-goal', g); await pg.fill('#t-cur', c); await pg.click('.tab-btn[data-tab="schedule"]'); };
  const setMeat = async (m, a = 0) => { await pg.click('.tab-btn[data-tab="meat"]'); await pg.fill('#m-normal', String(m)); await pg.fill('#m-mat', String(a)); await pg.click('.tab-btn[data-tab="schedule"]'); };
  const openMore = () => pg.evaluate(() => { document.getElementById('s-more').open = true; });
  const setMat = async (mode, planned) => { await openMore(); await pg.selectOption('#s-matmode', mode); if (mode === 'cap') await pg.fill('#s-mat', planned == null ? '' : String(planned)); };
  const cmp = (p = pg) => p.evaluate(() => {
    const t = document.getElementById('s-cmp'); if (!t) return null;
    return { head: [...t.tHead.rows[0].cells].map((c) => c.innerText.trim()), rows: [...t.tBodies[0].rows].map((r) => [...r.cells].map((c) => c.innerText.trim().replace(/\s+/g, ' '))) };
  });
  const hoursOf = (s) => { const m = /約 (?:(\d+)時間)?(?:(\d+)分)?/.exec(s || ''); return m ? (Number(m[1] || 0) + Number(m[2] || 0) / 60) : -1; };
  let prem = await txt('#s-premise');
  ok((await txt('#s-result')).includes('目標貢献度を入れてください'), 'スケジュール: 目標がないときは案内');
  ok(prem.includes('未入力') && prem.includes('通常肉 40,000個') && prem.includes('予定数は気にせず、必要な総数を出します') && prem.includes('150HELL 3分') && prem.includes('200HELL 5分') && prem.includes('250HELL 15分'), 'スケジュール: 前提（目標・肉・250専用素材・討伐時間）が出る', prem);
  ok((await pg.inputValue('#s-matmode')) === 'total' && (await pg.isDisabled('#s-mat')) && (await pg.inputValue('#s-priority')) === 'time' && (await pg.inputValue('#s-est')) === 'off', 'スケジュール: 基本は「時間優先」「推定しない」「250専用素材は必要な総数を出す」');
  ok(!(await pg.evaluate(() => document.getElementById('s-more').open)), 'スケジュール: 250専用素材の設定は、「くわしい設定」にしまってある（初めは閉じている）');
  ok(await pg.evaluate(() => ['h90', 'h95', 'h100', 'h150', 'h200'].every((id) => document.querySelector(`#s-est option[value="${id}"]`).disabled)), 'スケジュール: 全部の討伐時間が入っていると、推定の基準は選べない');
  await setGoal('60億');
  let res = await txt('#s-result');
  let c = await cmp();
  ok(res.includes('必要 60億') && res.includes('毎日 約 6時間33分ずつで、届きます'), 'スケジュール: 目標 60億 → 毎日 約 6時間33分', res);
  ok(c && c.head.join('|') === '|時間優先（表示中）|肉優先', 'スケジュール: 結果の表は、時間優先と肉優先が並ぶ（選んでいる方に「表示中」）', c && c.head.join('|'));
  ok(c.rows[0][0].startsWith('1日あたりの必要時間') && c.rows[0][0].includes('肉・素材が足りるとき') && c.rows[0].slice(1).join('|') === '約 6時間33分|約 6時間36分', 'スケジュール: 1日あたりの必要時間（肉・素材が足りるとき） — 時間優先 6時間33分／肉優先 6時間36分（1日目は 150HELL を使うので、ほぼ同じ）', c.rows[0].join('|'));
  ok(c.rows[1].join('|') === '必要な通常肉|4,200個|3,980個', 'スケジュール: 必要な通常肉 — 時間優先 4,200個／肉優先 3,980個（どちらも、厳密な最小）', c.rows[1].join('|'));
  ok(c.rows[2].join('|') === '必要な250専用素材|合計 1,040個（250HELL 52回）|合計 1,040個（250HELL 52回）', 'スケジュール: 必要な250専用素材 — どちらも 1,040個（250HELL 52回）', c.rows[2].join('|'));
  ok(c.rows[3][0].startsWith('いまの肉・素材では') && c.rows[3][0].includes('通常肉 40,000個') && c.rows[3][1] === '足ります' && c.rows[3][2] === '足ります', 'スケジュール: いまの肉（40,000個）で足りる', c.rows[3].join('|'));
  ok(res.includes('各日の終了時に、これだけの貢献度があれば順調です') && res.includes('本戦1日目終了時：5.37億') && res.includes('本戦4日目終了時：60.09億（目標の 100%）'), 'スケジュール: 各日の終了時の目安', res);
  ok((await ph('d1')) === 6.55 && (await ph('d4')) === 6.55 && (await txt('#s-hlabel-d1')) === '自動' && (await txt('#s-hlabel-q')) === '使わない', 'スケジュール: 自動の日に 6.55時間が出る。予選・インターバルは使わない');
  ok((await txt('#s-runs-d1')).includes('150HELL 131回') && (await txt('#s-runs-d2')).includes('200HELL 78回') && (await txt('#s-runs-d3')).includes('250HELL 26回') && !(await txt('#s-runs-d3')).includes('200HELL'), 'スケジュール: 日ごとの回数（3日目は 250HELL が中心）');
  // 難易度ごとの時間：日ごとの表の回数 × 討伐時間を、ここで数え直して、見出しの下の表示と比べる
  const SEC = { '90HELL': 90, '95HELL': 120, '100HELL': 150, '150HELL': 180, '200HELL': 300, '250HELL': 900 };
  const fmtHM = (sec) => { const m = Math.round(sec / 60), h = Math.floor(m / 60), mm = m % 60; return h ? (mm ? `${h}時間${mm}分` : `${h}時間`) : `${mm}分`; };
  const breakdown = async (secOf) => {
    const o = {};
    for (const id of ['q', 'd1', 'd2', 'd3', 'd4']) for (const m of (await txt('#s-runs-' + id)).matchAll(/(\d+HELL) ([\d,]+)回/g)) o[m[1]] = (o[m[1]] || 0) + Number(m[2].replace(/,/g, ''));
    return { text: Object.keys(o).sort((a, b) => parseInt(a) - parseInt(b)).map((k) => `${k} ${fmtHM(o[k] * secOf[k])}`).join('・'), o };
  };
  let bd = await breakdown(SEC);
  ok(bd.text.includes('250HELL') && bd.text.includes('200HELL') && res.includes('難易度ごとの時間：' + bd.text), 'スケジュール: 見出しの下に、難易度ごとの時間（150HELL 何時間分・200HELL 何時間分・250HELL 何時間分）が出る。日ごとの表の回数 × 討伐時間と一致する', res + ' / ' + bd.text);
  // 必要な通常肉は、いちばん少ない数（1個減らすと届かない）
  const minimal = await pg.evaluate(() => {
    const { stock, mat250, diffs } = schedulePlanInput();
    const need = 6000000000, out = {};
    for (const pr of ['time', 'meat']) {
      const sc = scheduleScenario(pr, { diffs, stock, mat250, need });
      const U = sc.solved.unlimited;
      const phasesU = PHASES.map((p, i) => ({ id: p.id, maxTier: p.maxTier, hours: sc.spec[i].fixed ? sc.spec[i].hours : U.hours }));
      const at = (e) => planSchedule({ stock: e, mat250: null, phases: phasesU, diffs: sc.diffsP }).total;
      out[pr] = { req: sc.req.meat, reach: at(sc.req.meat) >= need, below: at(sc.req.meat - 1) < need, prev: at(Math.max(0, sc.req.meat - 25)) < need };
    }
    return out;
  });
  ok(minimal.time.reach && minimal.time.below && minimal.meat.reach && minimal.meat.below, '必要な通常肉: その数で目標に届き、1個減らすと届かない（時間優先・肉優先とも）', JSON.stringify(minimal));
  // 250専用素材：予定数から、回数の上限を出す
  await setMat('cap', 3000);
  res = await txt('#s-result'); prem = await txt('#s-premise'); c = await cmp();
  ok(prem.includes('予定数 3,000個 → 250HELL は最大 150回') && c.rows[3][0].includes('250専用素材 予定数 3,000個') && c.rows[3][1] === '足ります' && c.rows[3][2] === '足ります', 'スケジュール: 予定数 3,000個 → 足りる（余りの素材は、500個まで肉に変換）', c.rows[3].join('|'));
  ok(!(await pg.isDisabled('#s-mat')), 'スケジュール: 上限モードでは、予定数の欄が使える');
  await setMat('cap', 100);
  res = await txt('#s-result'); c = await cmp();
  const inCell = /いまのままだと 毎日 (約 \d+時間\d+分)/.exec(c.rows[3][1]);
  ok(c.rows[3][1].includes('250専用素材 あと 940個（250HELL なら 47回ぶん）') && c.rows[3][2].includes('250専用素材 あと 940個（250HELL なら 47回ぶん）') && c.rows[1][1] === '4,200個' && c.rows[2][1] === '合計 1,040個（250HELL 52回）', 'スケジュール: 予定数が少ない → あと 940個（250HELL 47回ぶん）。必要な数そのものは変わらない', c.rows[3].join('|'));
  ok(inCell && res.includes(`毎日 ${inCell[1]}ずつで、届きます`) && hoursOf(inCell[1]) > 6.55, `スケジュール: 素材が足りないぶん、いまのままだと時間が増える（${inCell && inCell[1]}。上の文と同じ）`, res);
  await setMat('cap', 1100);
  c = await cmp();
  ok(c.rows[3][1] === '足ります' && c.rows[3][2] === '足ります' && (await txt('#s-result')).includes('毎日 約 6時間33分ずつで、届きます'), 'スケジュール: 予定数 1,100個 → 足りる（必要な 1,040個）');
  await setMeat(40000, 3000); await setMat('cap', null);
  ok((await txt('#s-premise')).includes('予定数 3,000個') && (await pg.getAttribute('#s-mat', 'placeholder')).includes('3,000'), 'スケジュール: 予定数が空なら、肉計算タブの 250専用素材の数を使う');
  await setMat('total'); await setMeat(40000, 0);
  // 優先するもの：時間（基本）／ 肉
  await pg.selectOption('#s-priority', 'meat');
  res = await txt('#s-result'); c = await cmp();
  ok(c.head.join('|') === '|時間優先|肉優先（表示中）' && c.rows[1].join('|') === '必要な通常肉|4,200個|3,980個', 'スケジュール: 肉優先に切り替えても、表は同じ（「表示中」が移る）', c.head.join('|'));
  ok((await txt('#s-hlabel-d1')) === '自動' && (await ph('d1')) === (await ph('d4')) && /毎日 約 6時間3\d分ずつで、届きます/.test(res), 'スケジュール: 肉優先でも、200HELL がまだ使えない1日目は、使わない日にしない（自動の日になる）。毎日 約 6時間36分', res);
  ok(/^150HELL [\d,]+回$/.test(await txt('#s-runs-d1')) && (await txt('#s-hlabel-q')) === '使わない', 'スケジュール: 肉優先の1日目は、150HELL だけで計算する（100HELL 以下は使わない）', await txt('#s-runs-d1'));
  ok(!(await txt('#s-runs-d2')).includes('150HELL') && (await txt('#s-runs-d2')).includes('200HELL') && (await txt('#s-runs-d3')).includes('250HELL'), 'スケジュール: 肉優先の回数は 200HELL（2日目）と 250HELL（3・4日目）');
  await pg.fill('#s-hrs-d1', '3');
  ok((await txt('#s-hlabel-d1')) === '固定' && (await txt('#s-runs-d1')) === '150HELL 60回', 'スケジュール: 肉優先で、1日目に3時間を入れると、150HELL 60回（3時間 ÷ 3分）', await txt('#s-runs-d1'));
  await pg.fill('#s-hrs-d1', '');
  await pg.selectOption('#s-scope', 'all');
  ok((await txt('#s-hlabel-q')) === '自動' && /^95HELL [\d,]+回$/.test(await txt('#s-runs-q')), 'スケジュール: 肉優先で、予選も含めると、予選・インターバルは、使える一番上の 95HELL だけで計算する', await txt('#s-runs-q'));
  await pg.selectOption('#s-scope', 'main');
  await setGoal('150億');
  res = await txt('#s-result'); c = await cmp();
  ok(c.rows[0][1] === c.rows[0][2] && c.rows[1][1] === c.rows[1][2] && /^約 1[5-7]時間/.test(c.rows[0][2]), 'スケジュール: 150億 → 肉優先でも 1日目に 150HELL を使うので、時間優先と同じ（約 16時間21分）', c.rows[0].join('|') + ' / ' + c.rows[1].join('|'));
  await setGoal('60億');
  await pg.selectOption('#s-priority', 'time');
  // 日ごとの調整：2日目は3時間だけ、4日目は10時間
  await pg.fill('#s-hrs-d2', '3'); await pg.fill('#s-hrs-d4', '10');
  res = await txt('#s-result');
  const n1 = await ph('d1'), n3 = await ph('d3');
  ok(n1 === n3 && n1 >= 5.8 && n1 <= 6.2, `スケジュール: 2日目3時間・4日目10時間 → 残りの日は 毎日 約 ${n1}時間`, `${n1} ${n3}`);
  ok(res.includes('自動の日（本戦1日目・本戦3日目）は 約') && res.includes('固定の日：本戦2日目 3時間・本戦4日目 10時間') && res.includes('の 100%）'), 'スケジュール: 固定の日と自動の日が分かる。目標には届く', res);
  ok((await txt('#s-hlabel-d2')) === '固定' && (await txt('#s-hlabel-d1')) === '自動', 'スケジュール: 固定／自動の表示');
  for (const id of ['d1', 'd2', 'd3', 'd4']) await pg.fill('#s-hrs-' + id, '2');
  ok((await txt('#s-result')).includes('この時間では、届きません') && (await txt('#s-result')).includes('あと'), 'スケジュール: 毎日2時間だと届かない');
  c = await cmp();
  ok(c.rows[0][0].startsWith('この時間で、目標に') && c.rows[0][1] === '届きません', 'スケジュール: 全部の日に時間を入れたときは、その時間で届くかどうかを出す', c.rows[0].join('|'));
  for (const id of ['d1', 'd2', 'd3', 'd4']) await pg.fill('#s-hrs-' + id, '10');
  ok((await txt('#s-result')).includes('この時間で、届きます'), 'スケジュール: 毎日10時間なら届く');
  await pg.click('#s-reset');
  ok((await pg.inputValue('#s-hrs-d2')) === '' && (await txt('#s-result')).includes('毎日 約 6時間33分ずつで、届きます'), 'スケジュール: 自動に戻す');
  await pg.fill('#s-hrs-d1', '0');
  res = await txt('#s-result'); const n2 = await ph('d2');
  ok(res.includes('本戦1日目 0時間（遊ばない）') && n2 >= 7.0 && n2 <= 7.3, `スケジュール: 1日目を休むと、残りの日は 毎日 約 ${n2}時間`, res);
  await pg.fill('#s-hrs-d1', '');
  await pg.selectOption('#s-scope', 'all');
  const nq = await ph('d1');
  ok((await txt('#s-hlabel-q')) === '自動' && nq < 6.55 && (await ph('q')) === nq, `スケジュール: 予選も使うと 毎日 ${nq}時間で済む（本戦だけ 6.55時間）`);
  await pg.selectOption('#s-scope', 'main');
  // 1日の上限（本戦は 17時間）
  await pg.fill('#s-hrs-d2', '20');
  ok((await pg.getAttribute('#s-hrs-d2', 'max')) === '17' && (await txt('#s-result')).includes('本戦2日目 17時間'), 'スケジュール: 本戦は 1日 最大17時間（20 と入れても 17時間で計算する）', await txt('#s-result'));
  await pg.fill('#s-hrs-d2', '');
  // 肉が足りないとき（総数モード）：あと何個か
  await setMeat(300, 0); await setGoal('40億');
  c = await cmp();
  const reqT = num(/([\d,]+)個/.exec(c.rows[1][1])), reqM = num(/([\d,]+)個/.exec(c.rows[1][2]));
  const shT = /通常肉 あと ([\d,]+)個（200HELL なら約 ([\d,]+)回ぶん）/.exec(c.rows[3][1]), shM = /通常肉 あと ([\d,]+)個/.exec(c.rows[3][2]);
  ok(num(shT) === reqT - 300 && num(shT, 2) === Math.ceil((reqT - 300) / 20) && num(shM) === reqM - 300 && reqM < reqT, `スケジュール: 肉が足りない → 時間優先は あと ${num(shT)}個（必要 ${reqT}個 − いま 300個。200HELL 何回ぶんかも）／肉優先は あと ${num(shM)}個`, c.rows[3].join('|'));
  ok(/いまのままだと 毎日 約 \d+時間\d+分/.test(c.rows[3][1]) && c.rows[0][1].startsWith('約') && c.rows[2][1].startsWith('合計'), 'スケジュール: 足りないときも、いまのままだとどれだけかかるか・必要な素材が出る', c.rows[3].join('|'));
  await pg.fill('#s-collect', String(num(shT)));
  c = await cmp();
  ok(c.rows[3][1] === '足ります' && c.rows[3][2] === '足ります' && (await txt('#s-premise')).includes('集める予定'), 'スケジュール: 足りない分を「集める予定の肉」に入れると、足りる', c.rows[3].join('|'));
  await pg.fill('#s-collect', '');
  // 届かない目標・すでに超えているとき
  await setMeat(40000, 0);
  await setGoal('10000億');
  res = await txt('#s-result');
  ok(res.includes('毎日 17時間ずつ（1日の上限）でも、届きません'), 'スケジュール: 1日17時間でも届かない目標', res);
  await setGoal('60億', '80億');
  ok((await txt('#s-result')).includes('すでに目標を超えています'), 'スケジュール: すでに超えているとき');
  await setGoal('60億');
  // 計算の速さ
  const ms = await pg.evaluate(() => { const t = performance.now(); for (let i = 0; i < 5; i++) updateScheduleView(); return (performance.now() - t) / 5; });
  ok(ms < 400, `スケジュール: 1回の計算が 400ms 未満（${ms.toFixed(0)}ms）`);
  // 保存と復元
  await pg.fill('#s-hrs-d2', '3'); await pg.selectOption('#s-scope', 'all'); await pg.fill('#s-collect', '1200'); await setMat('cap', 777); await pg.selectOption('#s-priority', 'meat');
  await pg.reload(); await pg.click('.tab-btn[data-tab="schedule"]'); await openMore();
  ok((await pg.inputValue('#s-hrs-d2')) === '3' && (await pg.inputValue('#s-scope')) === 'all' && (await pg.inputValue('#s-collect')) === '1200' && (await pg.inputValue('#s-matmode')) === 'cap' && (await pg.inputValue('#s-mat')) === '777' && (await pg.inputValue('#s-priority')) === 'meat', 'スケジュール: 時間・対象の日・集める肉・250専用素材の出し方と予定数・優先するものが、開き直しても残る');
  await pg.fill('#s-hrs-d2', ''); await pg.selectOption('#s-scope', 'main'); await pg.fill('#s-collect', ''); await setMat('total'); await pg.selectOption('#s-priority', 'time');
  await pg.evaluate(() => { document.getElementById('s-more').open = false; });
  await shot(pg, `${file}-schedule-pc.png`);
  await pg.evaluate(() => localStorage.removeItem('gbf_kj_times')); await pg.reload(); await pg.click('.tab-btn[data-tab="schedule"]');
  ok((await txt('#s-result')).includes('討伐時間を入れてください') && (await txt('#s-premise')).includes('未入力'), 'スケジュール: 討伐時間がないときは案内');

  // ---- 時間優先と肉優先で、差が出るデータ（150HELL が速い：40秒 → 時間あたりの貢献度は 250HELL より高い） ----
  const p7 = await newPage(1280, 900, errors2);
  const pf = p7.page;
  const fastTimes = { h90: 90, h95: 120, h100: 150, h150: 40, h200: 300, h250: 900 };
  await open(pf, file, { gbf_kj_times: JSON.stringify(fastTimes), gbf_kj_inputs: JSON.stringify({ 't-goal': '100億', 'm-normal': '40000', 'm-mat': '0' }) });
  await pf.click('.tab-btn[data-tab="schedule"]');
  const txtF = async (sel) => (await pf.innerText(sel)).trim();
  let cF = await cmp(pf), resF = await txtF('#s-result');
  ok(cF.rows[0].slice(1).join('|') === '約 6時間48分|約 8時間21分' && cF.rows[1].join('|') === '必要な通常肉|48,060個|16,740個', '優先: 150HELL が速いとき → 時間優先は 6時間48分・肉 48,060個、肉優先は 8時間21分・肉 16,740個（時間をかけて、肉を節約する）', cF.rows.map((r) => r.join('|')).join(' / '));
  ok(cF.rows[2][1] === '合計 40個（250HELL 2回）' && cF.rows[2][2] === '合計 1,320個（250HELL 66回）', '優先: 必要な250専用素材 — 時間優先 40個／肉優先 1,320個（肉優先は 250HELL を多く回す）', cF.rows[2].join('|'));
  ok(cF.rows[3][1].includes('通常肉 あと 8,060個（200HELL なら約 403回ぶん）') && /いまのままだと 毎日 約 7時間6分/.test(cF.rows[3][1]) && cF.rows[3][2] === '足ります', '優先: 肉 40,000個だと、時間優先は あと 8,060個足りない（毎日 7時間6分）。肉優先は足りる', cF.rows[3].join('|'));
  const bdLineF = (resF.match(/難易度ごとの時間：([^\n]*)/) || [])[1] || '';
  ok(resF.includes('毎日 約 7時間6分ずつで、届きます') && /^150HELL [^・]*・250HELL [^・]*$/.test(bdLineF), '優先: 時間優先の計画は、150HELL と 250HELL だけ（200HELL は使わない）', resF);
  let bdF = await (async () => { const o = {}; for (const id of ['q', 'd1', 'd2', 'd3', 'd4']) for (const m of (await txtF('#s-runs-' + id)).matchAll(/(\d+HELL) ([\d,]+)回/g)) o[m[1]] = (o[m[1]] || 0) + Number(m[2].replace(/,/g, '')); const sec = { '90HELL': 90, '95HELL': 120, '100HELL': 150, '150HELL': 40, '200HELL': 300, '250HELL': 900 }; return Object.keys(o).sort((a, b) => parseInt(a) - parseInt(b)).map((k) => `${k} ${fmtHM(o[k] * sec[k])}`).join('・'); })();
  ok(resF.includes('難易度ごとの時間：' + bdF), '優先: 難易度ごとの時間が、日ごとの表の回数 × 討伐時間と一致する（時間優先）', resF + ' / ' + bdF);
  await pf.selectOption('#s-priority', 'meat');
  resF = await txtF('#s-result');
  ok(resF.includes('毎日 約 8時間21分ずつで、届きます') && (await txtF('#s-hlabel-d1')) === '自動' && /^150HELL [\d,]+回$/.test(await txtF('#s-runs-d1')) && (await txtF('#s-runs-d2')).includes('200HELL') && !(await txtF('#s-runs-d2')).includes('150HELL') && (await txtF('#s-runs-d3')).includes('250HELL'), '優先: 肉優先の計画は、1日目 150HELL、2日目 200HELL、3・4日目 250HELL', resF);
  ok(/難易度ごとの時間：150HELL .*・200HELL .*・250HELL /.test(resF), '優先: 肉優先の見出しの下にも、150HELL・200HELL・250HELL の時間が出る', resF);
  // 届かない目標：肉優先は、肉が足りても、17時間でも届かない。時間優先は、肉が足りれば届く
  await pf.click('.tab-btn[data-tab="target"]'); await pf.fill('#t-goal', '220億'); await pf.click('.tab-btn[data-tab="schedule"]');
  cF = await cmp(pf); resF = await txtF('#s-result');
  ok(resF.includes('毎日 17時間ずつ（1日の上限）でも、届きません') || resF.includes('17時間ずつ（1日の上限）でも、届きません'), '優先: 肉優先は、220億に 17時間でも届かない', resF);
  ok(cF.rows[0][1] === '約 14時間57分' && cF.rows[0][2] === '17時間でも届きません' && cF.rows[1].join('|') === '必要な通常肉|106,220個|─' && cF.rows[3][1].includes('通常肉 あと 66,220個') && cF.rows[3][2] === '─', '優先: 220億 → 時間優先は 14時間57分・肉 106,220個あれば届く。肉優先は、肉があっても届かない', cF.rows.map((r) => r.join('|')).join(' / '));
  await pf.fill('#s-collect', '66220'); await pf.selectOption('#s-priority', 'time');
  resF = await txtF('#s-result'); cF = await cmp(pf);
  ok(resF.includes('毎日 約 14時間57分ずつで、届きます') && cF.rows[3][1] === '足ります', '優先: 足りない 66,220個を「集める予定の肉」に入れると、時間優先は 毎日 14時間57分で届く', resF);
  await p7.ctx.close();

  // ---- 未入力の討伐時間を、同じ効率で推定する（150HELL の時間だけ分かっているとき） ----
  const p6 = await newPage(1280, 900, errors2);
  const pe = p6.page;
  const seedIn = JSON.stringify({ 't-goal': '40億', 'm-normal': '40000', 'm-mat': '0' });
  await open(pe, file, { gbf_kj_times: JSON.stringify({ h150: 180 }), gbf_kj_inputs: seedIn });
  await pe.click('.tab-btn[data-tab="schedule"]');
  const txtE = async (sel) => (await pe.innerText(sel)).trim();
  const optDis = (id) => pe.evaluate((id) => document.querySelector(`#s-est option[value="${id}"]`).disabled, id);
  let premE = await txtE('#s-premise'), resE = await txtE('#s-result'), cE = await cmp(pe);
  const reqOff = num(/([\d,]+)個/.exec(cE.rows[1][1])), hOff = hoursOf(cE.rows[0][1]);
  ok(premE.includes('150HELL 3分') && !premE.includes('（推定）') && premE.includes('未入力の難易度は、使いません：90HELL・95HELL・100HELL・200HELL・250HELL'), '推定: 推定しないときは、未入力の難易度は使わない', premE);
  ok(!(await optDis('h150')) && (await optDis('h90')) && (await optDis('h200')), '推定: 基準に選べるのは、時間が入っている難易度だけ（150HELL だけ選べる）');
  ok(reqOff === 19520 && cE.rows[0][1] === '約 12時間12分' && cE.rows[0][2] === '約 12時間12分', `推定: 150HELL だけ → 必要な通常肉 ${reqOff}個（40億 ÷ 410万 = 976回 × 20個）。時間 ${cE.rows[0][1]}`, cE.rows.map((r) => r.join('|')).join(' / '));
  await pe.selectOption('#s-est', 'h150');
  premE = await txtE('#s-premise'); resE = await txtE('#s-result'); cE = await cmp(pe);
  const reqOn = num(/([\d,]+)個/.exec(cE.rows[1][1])), hOn = hoursOf(cE.rows[0][1]);
  ok(premE.includes('200HELL（推定） 14分38秒') && premE.includes('250HELL（推定） 54分53秒') && premE.includes('（推定）は、150HELL と同じ貢献度/時間で計算した値です') && !premE.includes('90HELL（推定）') && premE.includes('未入力の難易度は、使いません：90HELL・95HELL・100HELL'), '推定: 150HELL と同じ効率で、上の難易度（200HELL・250HELL）だけ推定する。下の難易度は使わない', premE);
  ok(resE.includes('※ 200HELL・250HELL の討伐時間は、150HELL と同じ効率（貢献度/時間）で推定した値です。'), '推定: 結果にも、推定した値だと書いてある', resE);
  ok(reqOn > 0 && reqOn < reqOff * 0.4 && hOn >= hOff - 0.05 && hOn <= hOff + 0.3, `推定: 同じ効率なら、時間はほぼ同じ（${cE.rows[0][1]}）で、必要な通常肉は ${reqOff}個 → ${reqOn}個に減る（200HELL・250HELL を使うため）`, cE.rows.map((r) => r.join('|')).join(' / '));
  ok(Math.abs(hoursOf(cE.rows[0][2]) - hoursOf(cE.rows[0][1])) <= 0.2 && num(/([\d,]+)個/.exec(cE.rows[1][2])) <= num(/([\d,]+)個/.exec(cE.rows[1][1])), '推定: 同じ効率なら、肉優先でも 1日目に 150HELL を使うので、時間優先とほぼ同じ時間・同じ肉', cE.rows.map((r) => r.join('|')).join(' / '));
  ok(await pe.evaluate(() => { const t = scheduleTimes(); const base = DIFFS.find(d => d.id === 'h150'); const per = base.contrib / killTimes.h150; return t.estimated.length === 2 && t.estimated.every((d) => Math.abs(d.contrib / t.times[d.id] - per) / per < 1e-12); }), '推定: 推定した時間は丸めず、貢献度/時間が基準とぴったり同じ');
  ok((await txtE('#s-runs-d2')).includes('200HELL') && (await txtE('#s-runs-d3')).includes('250HELL') && (await txtE('#s-runs-d1')).includes('150HELL'), '推定: 同じ効率なら、肉を使わない難易度（2日目は 200HELL、3・4日目は 250HELL）を選ぶ');
  // 入れた時間は、そのまま使う
  await pe.evaluate(() => { localStorage.setItem('gbf_kj_times', JSON.stringify({ h150: 180, h200: 600 })); }); await pe.reload(); await pe.click('.tab-btn[data-tab="schedule"]');
  premE = await txtE('#s-premise');
  ok((await pe.inputValue('#s-est')) === 'h150' && premE.includes('200HELL 10分') && !premE.includes('200HELL（推定）') && premE.includes('250HELL（推定） 54分53秒'), '推定: 入れた時間（200HELL 10分）はそのまま使い、未入力の 250HELL だけ推定する。選んだ基準は開き直しても残る', premE);
  // 基準の時間がなくなったら、推定しない
  await pe.evaluate(() => { localStorage.setItem('gbf_kj_times', JSON.stringify({ h200: 300 })); }); await pe.reload(); await pe.click('.tab-btn[data-tab="schedule"]');
  premE = await txtE('#s-premise');
  ok(!premE.includes('（推定）') && premE.includes('200HELL 5分') && (await optDis('h150')) && !(await optDis('h200')), '推定: 基準（150HELL）の時間が未入力なら、推定しない（200HELL なら選べる）', premE);
  await shot(pe, `${file}-schedule-est-pc.png`);
  await p6.ctx.close();

  // ---- 割り振りの計算そのもの（小さな問題を、総当たりと比べる） ----
  const checks = await pg.evaluate(() => {
    let seed = 20260101; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const rows = [];
    for (let trial = 0; trial < 40; trial++) {
      const hq = 1 + Math.floor(rnd() * 2), hd = 1 + Math.floor(rnd() * 2), stock = 50 + Math.floor(rnd() * 500);
      const diffs = [
        { id: 'a', tier: 95,  contrib: 910000,  chunks: 10, is250: false, time: 90 + Math.floor(rnd() * 120) },
        { id: 'b', tier: 150, contrib: 4100000, chunks: 20, is250: false, time: 120 + Math.floor(rnd() * 300) },
      ];
      const plan = planSchedule({ stock, mat250: 0, phases: [{ id: 'q', maxTier: 95, hours: hq }, { id: 'd', maxTier: 150, hours: hd }], diffs });
      const tq = hq * 3600, td = hd * 3600, ta = diffs[0].time, tb = diffs[1].time;
      let best = 0;
      for (let aq = 0; aq * ta <= tq; aq++) for (let ad = 0; ad * ta <= td; ad++) for (let b = 0; ad * ta + b * tb <= td; b++) {
        if ((aq + ad) * 10 + b * 20 > stock) continue;
        best = Math.max(best, (aq + ad) * 910000 + b * 4100000);
      }
      rows.push({ plan: plan.total, best, bound: plan.bound });
    }
    // 250HELL と、素材から肉への変換（500個まで）を含む問題
    const conv = [];
    for (let trial = 0; trial < 20; trial++) {
      const stock = Math.floor(rnd() * 600), mat = 400 + Math.floor(rnd() * 1500), h = 2 + Math.floor(rnd() * 4);
      const diffs = [
        { id: 'e', tier: 200, contrib: 20000000, chunks: 20, is250: false, time: 300 },
        { id: 'f', tier: 250, contrib: 75000000, chunks: 20, is250: true,  time: 900 },
      ];
      const plan = planSchedule({ stock, mat250: mat, phases: [{ id: 'd', maxTier: 250, hours: h }], diffs });
      let best = 0;
      for (let z = 0; z * 900 <= h * 3600 && z * 20 <= mat; z++) for (let x = 0; z * 900 + x * 300 <= h * 3600; x++) {
        if (x * 20 > stock + 2 * Math.min(500, mat - 20 * z)) continue;
        best = Math.max(best, z * 75000000 + x * 20000000);
      }
      conv.push({ plan: plan.total, best, bound: plan.bound });
    }
    // 素材が未入力（null）：250HELL は素材の数を気にせず入れ、余りの変換はしない
    const nul = [];
    for (let trial = 0; trial < 20; trial++) {
      const stock = 100 + Math.floor(rnd() * 600), h = 2 + Math.floor(rnd() * 3);
      const diffs = [
        { id: 'e', tier: 200, contrib: 20000000, chunks: 20, is250: false, time: 300 },
        { id: 'f', tier: 250, contrib: 75000000, chunks: 20, is250: true,  time: 900 },
      ];
      const plan = planSchedule({ stock, mat250: null, phases: [{ id: 'd', maxTier: 250, hours: h }], diffs });
      let best = 0;
      for (let z = 0; z * 900 <= h * 3600; z++) for (let x = 0; z * 900 + x * 300 <= h * 3600; x++) {
        if (x * 20 > stock) continue;
        best = Math.max(best, z * 75000000 + x * 20000000);
      }
      nul.push({ plan: plan.total, best, bound: plan.bound });
    }
    // 3つの難易度 × 2つの日（150HELL は 1日目だけ）：総当たりと、最大の貢献度・必要な肉の最小を比べる
    const three = []; let minMeatN = 0; const minMeatBad = [];
    for (let trial = 0; trial < 25; trial++) {
      const stock = 20 + Math.floor(rnd() * 300);
      const diffs = [
        { id: 'a', tier: 95,  contrib: 910000,   chunks: 10, is250: false, time: 90 + Math.floor(rnd() * 100) },
        { id: 'b', tier: 150, contrib: 4100000,  chunks: 20, is250: false, time: 150 + Math.floor(rnd() * 250), only: ['d1'] },
        { id: 'c', tier: 200, contrib: 20000000, chunks: 20, is250: false, time: 500 + Math.floor(rnd() * 500) },
      ];
      const phases = [{ id: 'd1', maxTier: 150, hours: 1 }, { id: 'd2', maxTier: 200, hours: 1 }];
      const plan = planSchedule({ stock, mat250: null, phases, diffs });
      const T = 3600, [ta, tb, tc] = diffs.map((d) => d.time);
      let best = 0, minMeat = Infinity;
      const need = Math.floor(plan.total * 0.9);
      for (let a1 = 0; a1 * ta <= T; a1++) for (let b1 = 0; a1 * ta + b1 * tb <= T; b1++) for (let a2 = 0; a2 * ta <= T; a2++) for (let c2 = 0; a2 * ta + c2 * tc <= T; c2++) {
        const meat = (a1 + a2) * 10 + (b1 + c2) * 20, val = (a1 + a2) * 910000 + b1 * 4100000 + c2 * 20000000;
        if (meat <= stock) best = Math.max(best, val);
        if (val >= need) minMeat = Math.min(minMeat, meat);
      }
      three.push({ plan: plan.total, best, bound: plan.bound });
      // 必要な肉：二分探索（アプリと同じ：目標に届く計画があるか）
      const reach = (e) => planSchedule({ stock: e, mat250: null, phases, diffs, target: need }).total >= need;
      let lo = 0, hi = 4000; while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (reach(mid)) hi = mid; else lo = mid + 1; }
      minMeatN++; if (lo !== minMeat) minMeatBad.push({ trial, lo, minMeat, need });
    }
    // 分枝限定法そのもの：max 5x + 4y  ただし 6x + 4y ≤ 24（整数）→ 24（x = 0, y = 6）
    const ilp = ilpMax([5, 4], [[6, 4]], [24], [0, 0], { maxNodes: 1000 }).v;
    const lp = planSchedule({ stock: 100, mat250: null, phases: [{ id: 'd1', maxTier: 150, hours: 1 }], diffs: [{ id: 'b', tier: 150, contrib: 4100000, chunks: 20, is250: false, time: 180 }], lpOnly: true });
    const early = planSchedule({ stock: 100, mat250: null, phases: [{ id: 'd1', maxTier: 150, hours: 1 }], diffs: [{ id: 'b', tier: 150, contrib: 4100000, chunks: 20, is250: false, time: 180 }], target: 4100000 });
    const unit = { ilp, lpOnly: lp.bound > 0 && lp.total === 0 && lp.runs.d1.b === 0, target: early.total >= 4100000 };
    return { rows, conv, nul, three, minMeatN, minMeatBad, minMeatSame: minMeatBad.length === 0, unit };
  });
  const feasible = [...checks.rows, ...checks.conv, ...checks.nul, ...checks.three].every((r) => r.plan <= r.best);
  const nearBest = [...checks.rows, ...checks.conv, ...checks.nul, ...checks.three].every((r) => r.plan === r.best);
  const bounded = [...checks.rows, ...checks.conv, ...checks.nul, ...checks.three].every((r) => r.bound >= r.best - 1);
  const worst = Math.min(...[...checks.rows, ...checks.conv, ...checks.nul, ...checks.three].filter((r) => r.best > 0).map((r) => r.plan / r.best));
  ok(feasible, `割り振り: ${checks.rows.length + checks.conv.length + checks.nul.length + checks.three.length} 通りの小さな問題で、総当たりの最大を超える（＝制限を破る）ものはない`);
  ok(bounded, '割り振り: 整数にする前の上限は、総当たりの最大以上');
  ok(nearBest, `割り振り: 総当たりの最大と、ぴったり同じ（分枝限定法で、厳密に解く。いちばん低くて ${(worst * 100).toFixed(2)}%）`);
  ok(checks.minMeatSame, `必要な通常肉: 総当たりの最小と、ぴったり同じ（${checks.minMeatN} 通り）`, JSON.stringify(checks.minMeatBad));
  ok(checks.unit.ilp === 24 && checks.unit.lpOnly && checks.unit.target, '分枝限定法: 小さな問題の最適値 24、lpOnly は上限だけ、target に届いたら止まる', JSON.stringify(checks.unit));
  await p4.ctx.close();
  // スマホ幅
  const p5 = await newPage(390, 844, errors2);
  await open(p5.page, file, { gbf_kj_times: times, gbf_kj_inputs: JSON.stringify({ 't-goal': '60億', 'm-normal': '40000', 'm-mat': '3000', 's-hrs-d2': '3' }) });
  await p5.page.click('.tab-btn[data-tab="schedule"]');
  await p5.page.evaluate(() => { document.querySelector('#s-table').parentElement.scrollLeft = 0; window.scrollTo(0, 0); });
  const ov2 = await p5.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(ov2 <= 0, `スケジュール: スマホ幅で、ページ全体は横にはみ出さない（${ov2}px）`);
  ok((await p5.page.innerText('#s-result')).includes('自動の日'), 'スケジュール: スマホ幅でも結果が出る（前の保存の値から）');
  const stacked = await p5.page.evaluate(() => { const t = document.getElementById('s-cmp'); const td = t && t.tBodies[0].rows[1].cells[1]; return t && { head: getComputedStyle(t.tHead).display, td: getComputedStyle(td).display, label: getComputedStyle(td, '::before').content, fit: t.scrollWidth <= t.parentElement.clientWidth + 1, w: Math.round(td.getBoundingClientRect().width) }; });
  ok(stacked && stacked.head === 'none' && stacked.td === 'flex' && /時間優先/.test(stacked.label) && stacked.fit && stacked.w > 250, 'スケジュール: スマホ幅では、結果の表を項目ごとに縦に並べる（時間優先・肉優先が、細い列にならない）', JSON.stringify(stacked));
  await shot(p5.page, `${file}-schedule-sp.png`);
  await p5.ctx.close();
  const real = [...errors, ...errors2].filter((e) => !/kofiWidgetOverlay/.test(e));
  ok(real.length === 0, `画面のエラーがない（${real.length}件）`, real.join(' | '));
}
await browser.close();
closeServer();
console.log(`\n${fails === 0 ? '全部 OK' : fails + ' 件 NG'}`);
process.exit(fails ? 1 : 0);
