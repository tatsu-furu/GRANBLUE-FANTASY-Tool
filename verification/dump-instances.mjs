import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, launchBrowser } from '../tests/lib.mjs';
const OUT = process.env.OUT || path.join(path.dirname(fileURLToPath(import.meta.url)), 'out', 'instances.json');   // 出力先（run.mjs が決める）
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
const goals = ['20億', '40億', '60億', '100億', '120億'];
const out = [];
for (const [tname, times] of Object.entries(timesets)) {
  for (const est of (tname === 'only150' ? ['h150'] : ['off'])) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.route('**/*', (route) => (new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort()));
    await page.addInitScript(([t, i]) => { localStorage.setItem('gbf_kj_times', t); localStorage.setItem('gbf_kj_inputs', i); }, [JSON.stringify(times), JSON.stringify({ 't-goal': '60億', 'm-normal': '40000', 'm-mat': '0', 's-est': est })]);
    await page.goto(`${base}/kosenjou.html`);
    await page.click('.tab-btn[data-tab="schedule"]');
    for (const goal of goals) {
      for (const scope of ['main', 'all']) {
        const r = await page.evaluate(({ goal, scope }) => {
          document.getElementById('t-goal').value = goal; document.getElementById('t-goal').dispatchEvent(new Event('input', { bubbles: true }));
          document.getElementById('s-scope').value = scope;
          const { stock, mat250, diffs } = schedulePlanInput();
          const need = parseGoal(goal) - (parseGoal(document.getElementById('t-cur').value) || 0);
          const res = [];
          for (const pr of ['time', 'meat']) {
            const sc = scheduleScenario(pr, { diffs, stock, mat250, need, hoursOpt: domHoursOpt() });
            const U = sc.solved.unlimited;
            const phasesU = PHASES.map((p, i) => ({ id: p.id, maxTier: p.maxTier, hours: sc.spec[i].fixed ? sc.spec[i].hours : U.hours }));
            const maxes = [];
            for (const S of [300, 1500, 3000, 6000, 12000, 40000]) { const pl = planSchedule({ stock: S, mat250: null, phases: phasesU, diffs: sc.diffsP }); maxes.push({ S, total: pl.total, bound: pl.bound }); }
            res.push({ pr, need, reachable: U.reachable, hours: U.hours, req: sc.req ? sc.req.meat : null, phases: phasesU, diffs: sc.diffsP, maxes });
          }
          return res;
        }, { goal, scope });
        for (const x of r) out.push({ tname, est, goal, scope, ...x });
      }
    }
    await ctx.close();
  }
}
fs.writeFileSync(OUT, JSON.stringify(out));
console.log('instances:', out.length, ' reachable:', out.filter((x) => x.reachable).length);
await browser.close(); closeServer();
