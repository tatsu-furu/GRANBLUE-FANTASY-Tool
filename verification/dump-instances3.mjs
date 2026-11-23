// 実際の肉・素材（足りないときも含む）での「毎日の時間」を、画面の関数から取り出す（厳密解との照合用）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, launchBrowser } from '../tests/lib.mjs';
const OUT = process.env.OUT || path.join(path.dirname(fileURLToPath(import.meta.url)), 'out', 'instances3.json');   // 出力先（run.mjs が決める）
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const { base, close: closeServer } = await startServer();
const browser = await launchBrowser();
const timesets = {
  full: { h90: 90, h95: 120, h100: 150, h150: 180, h200: 300, h250: 900 },
  slow250: { h90: 90, h95: 120, h100: 150, h150: 180, h200: 300, h250: 1800 },
  fast150: { h90: 90, h95: 120, h100: 150, h150: 40, h200: 300, h250: 900 },
  mid: { h90: 60, h95: 100, h100: 130, h150: 150, h200: 420, h250: 1200 },
  only150: { h150: 180 },
};
// 日ごとの時間の指定：全部○（自動）／2日目△（3時間）・3日目×／1日目は終わった・4日目は5時間（かんたん計画の経路）
const hoursVariants = {
  autoAll: null,
  tri2_x3: { includeQ: false, hours: { q: null, d1: null, d2: 3, d3: 0, d4: null } },
  past1_d4fixed: { includeQ: false, hours: { q: null, d1: 0, d2: null, d3: null, d4: 5 } },
};
const out = [];
for (const [tname, times] of Object.entries(timesets)) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.route('**/*', (route) => (new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort()));
  await page.addInitScript(([t, i]) => { localStorage.setItem('gbf_kj_times', t); localStorage.setItem('gbf_kj_inputs', i); }, [JSON.stringify(times), JSON.stringify({ 't-goal': '60億', 'm-normal': '40000', 'm-mat': '0', 's-est': tname === 'only150' ? 'h150' : 'off' })]);
  await page.goto(`${base}/kosenjou.html`);
  await page.click('.tab-btn[data-tab="schedule"]');
  for (const [hv, hoursOpt] of Object.entries(hoursVariants)) for (const goal of ['40億', '100億']) for (const meat of ['300', '1500', '6000']) for (const mat of [null, '200', '900']) {
    const r = await page.evaluate(({ goal, meat, mat, hoursOpt }) => {
      document.getElementById('t-goal').value = goal; document.getElementById('m-normal').value = meat;
      document.getElementById('s-scope').value = 'main';
      document.getElementById('s-matmode').value = mat == null ? 'total' : 'cap'; document.getElementById('s-mat').value = mat == null ? '' : mat;
      const { stock, mat250, diffs } = schedulePlanInput();
      const need = parseGoal(goal);
      const res = [];
      for (const pr of ['time', 'meat']) {
        const sc = scheduleScenario(pr, { diffs, stock, mat250, need, hoursOpt: hoursOpt || domHoursOpt() });
        const A = sc.solved.actual;
        const phases = PHASES.map((p, i) => ({ id: p.id, maxTier: p.maxTier, hours: sc.spec[i].fixed ? sc.spec[i].hours : A.hours }));
        res.push({ pr, need, stock, mat250, hours: A.hours, reachable: A.reachable, total: A.plan.total, phases, diffs: sc.diffsP, fixedHours: sc.spec.map((s) => s.fixed ? s.hours : null) });
      }
      return res;
    }, { goal, meat, mat, hoursOpt });
    for (const x of r) out.push({ tname, hv, goal, meat, mat, ...x });
  }
  await ctx.close();
}
fs.writeFileSync(OUT, JSON.stringify(out));
console.log('instances:', out.length, ' reachable:', out.filter((x) => x.reachable).length);
await browser.close(); closeServer();
