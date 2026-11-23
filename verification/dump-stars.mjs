// 極星器の本数の制約つきの問題（集合1の条件 × 本数 1・3 × おまかせ・90HELL 指定）を、計算の関数から取り出す（厳密解との照合用）。
// 集合1：討伐時間 5通り × 目標 5通り × 範囲 2通り × 優先 2通り（100問）→ 本数・難易度の指定をかけて 400問
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { loadEngine, read } from '../tests/engine.mjs';

const OUT = process.env.OUT || path.join(path.dirname(fileURLToPath(import.meta.url)), 'out', 'instances-stars.json');
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const E = loadEngine({ scripts: ['kosenjou-plan-core.js'] });
const PC = E.PlanCore;

// 難易度ごとの1周の確率：トレハンタブの既定の設定（200HELL・箱 4%・団サポ 20%・アイテム 8%）
const th = vm.createContext({ window: {} });
vm.runInContext(read('kosenjou-trehun.js'), th, { filename: 'kosenjou-trehun.js' });
const DEF = { diff: 'h200', boxBase: 4, itemRate: 8, trehun: 0, tears: 0, tearsOdds: 0, weathercock: 3, essel: 0, character: 0, coexist: false, richard: false, minic: false, weapon: 0, dbee: false, mainStone: 0, friendStone: 0, artifact: 0, precious: false, preciousFrame: 3 };
const perDiff = th.window.TrehunPanel.perDiff(DEF, E.HELL_DIFFS.map((d) => d.id));
const sp = PC.starProbs({ perDiff }, E.HELL_DIFFS);

const timesets = {
  full: { h90: 90, h95: 120, h100: 150, h150: 180, h200: 300, h250: 900 },
  slow250: { h90: 90, h95: 120, h100: 150, h150: 180, h200: 300, h250: 1800 },
  fast150: { h90: 90, h95: 120, h100: 150, h150: 40, h200: 300, h250: 900 },
  mid: { h90: 60, h95: 100, h100: 130, h150: 150, h200: 420, h250: 1200 },
  only150: { h150: 180 },
};
const goals = { '20億': 2e9, '40億': 4e9, '60億': 6e9, '100億': 1e10, '120億': 1.2e10 };
const out = [];
for (const [tname, times] of Object.entries(timesets)) for (const [goal, need] of Object.entries(goals)) for (const scope of ['main', 'all']) for (const pr of ['time', 'meat']) {
  const diffs = E.planDiffsFrom(times);
  const hoursOpt = { includeQ: scope === 'all', hours: {} };
  const stock = 40000, mat250 = null;
  const base = E.scheduleScenario(pr, { diffs, stock, mat250, need, hoursOpt });
  const ctx = { core: { PHASES: E.PHASES }, stock, mat250 };
  for (const n of [1, 3]) for (const extra of ['', 'h90']) {
    const t0 = performance.now();
    const core = { PHASES: E.PHASES, scheduleScenario: E.scheduleScenario };
    const sc = PC.starScenario(core, pr, { diffs, stock, mat250, need, hoursOpt, base, ctx, sp, n, mode: 'avg', extra });
    const ms = performance.now() - t0;
    const ex = extra && sp.q[extra] > 0 ? extra : null;
    const caps = ex ? PC.capsFrom(base, ctx, ex) : null;
    const U = sc.solved.unlimited;
    const phasesU = E.PHASES.map((p, i) => ({ id: p.id, maxTier: p.maxTier, hours: sc.spec[i].fixed ? sc.spec[i].hours : U.hours }));
    out.push({ tname, goal, scope, pr, n, extra, need, reachable: U.reachable, hours: U.hours, req: sc.req ? sc.req.meat : null, reqMat: sc.req ? sc.req.mat : null, ms, phases: phasesU, diffs: sc.diffsP, star: { n, q: sp.q }, caps });
  }
}
fs.writeFileSync(OUT, JSON.stringify(out));
const ms = out.map((x) => x.ms).sort((a, b) => a - b);
console.log(`極星器つきの問題 ${out.length}問（届く ${out.filter((x) => x.reachable).length}）・計算 中央 ${ms[Math.floor(ms.length / 2)].toFixed(0)}ms・90% ${ms[Math.floor(ms.length * 0.9)].toFixed(0)}ms・最大 ${ms[ms.length - 1].toFixed(0)}ms`);
