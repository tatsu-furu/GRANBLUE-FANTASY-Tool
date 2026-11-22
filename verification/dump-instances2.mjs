import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, launchBrowser } from '../tests/lib.mjs';
const OUT = process.env.OUT || path.join(path.dirname(fileURLToPath(import.meta.url)), 'out', 'instances2.json');   // 出力先（run.mjs が決める）
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const { base, close: closeServer } = await startServer();
const browser = await launchBrowser();
let seed = 777; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const timesets = {
  full: { h90: 90, h95: 120, h100: 150, h150: 180, h200: 300, h250: 900 },
  fast150: { h90: 90, h95: 120, h100: 150, h150: 40, h200: 300, h250: 900 },
  slow250: { h90: 90, h95: 120, h100: 150, h150: 180, h200: 300, h250: 1800 },
  only150: { h150: 180 },
};
for (let i = 0; i < 14; i++) timesets['rnd' + i] = { h90: 40 + Math.floor(rnd() * 120), h95: 60 + Math.floor(rnd() * 160), h100: 80 + Math.floor(rnd() * 200), h150: 60 + Math.floor(rnd() * 400), h200: 150 + Math.floor(rnd() * 700), h250: 400 + Math.floor(rnd() * 1800) };
const goals = ['30億', '70億', '110億'];
const out = [];
for (const [tname, times] of Object.entries(timesets)) {
  const est = tname === 'only150' ? 'h150' : 'off';
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
          const t0 = performance.now();
          const sc = scheduleScenario(pr, { diffs, stock, mat250, need, hoursOpt: domHoursOpt() });
          const ms = performance.now() - t0;
          const U = sc.solved.unlimited;
          const phasesU = PHASES.map((p, i) => ({ id: p.id, maxTier: p.maxTier, hours: sc.spec[i].fixed ? sc.spec[i].hours : U.hours }));
          const maxes = [];
          for (const S of [300, 1500, 3000, 6000, 12000, 40000]) { const pl = planSchedule({ stock: S, mat250: null, phases: phasesU, diffs: sc.diffsP }); maxes.push({ S, total: pl.total, bound: pl.bound }); }
          // 素材の予定数あり（変換あり）
          const maxesCap = [];
          for (const M of [200, 900, 2500]) for (const S of [500, 3000]) { const pl = planSchedule({ stock: S, mat250: M, phases: phasesU, diffs: sc.diffsP }); maxesCap.push({ S, M, total: pl.total, bound: pl.bound }); }
          res.push({ pr, need, reachable: U.reachable, hours: U.hours, req: sc.req ? sc.req.meat : null, reqMat: sc.req ? sc.req.mat : null, ms, phases: phasesU, diffs: sc.diffsP, maxes, maxesCap });
        }
        return res;
      }, { goal, scope });
      for (const x of r) out.push({ tname, goal, scope, ...x });
    }
  }
  await ctx.close();
}
fs.writeFileSync(OUT, JSON.stringify(out));
const ms = out.map((x) => x.ms).sort((a, b) => a - b);
console.log('instances:', out.length, ' reachable:', out.filter((x) => x.reachable).length, ' scheduleScenario ms: 中央', ms[Math.floor(ms.length / 2)].toFixed(1), ' 90%', ms[Math.floor(ms.length * 0.9)].toFixed(1), ' 最大', ms[ms.length - 1].toFixed(1));
await browser.close(); closeServer();
