// 計算（kosenjou-schedule.js）を、ブラウザなしで Node から呼ぶための部品。
// 画面のページと同じファイル（kosenjou-data.js・kosenjou-schedule.js）を、vm の中で読み込む。
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { root } from './lib.mjs';

export const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

/**
 * 計算を読み込んで、使う関数を返す。
 *   opts.performance … 時計の差し替え（時間に左右されないことの確認用）
 *   opts.scripts … さらに読み込むスクリプト（かんたん計画の計算 kosenjou-plan-core.js など）
 */
export function loadEngine(opts = {}) {
  const ctx = vm.createContext({ performance: opts.performance || performance, console });
  for (const f of ['kosenjou-data.js', 'kosenjou-schedule.js', ...(opts.scripts || [])]) vm.runInContext(read(f), ctx, { filename: f });
  const api = vm.runInContext(`({ DIFFS, HELL_DIFFS, tierOf, parseGoal, fmtGoal, PHASES, DAY_MAX_HOURS, usableIn, simplexMax, ilpMax, planSchedule, planDiffsFrom, allowedDiffs, scheduleHoursSpec, solveSchedule, scheduleUsage, hoursByDiff, scheduleScenario, verifyPlan,
    PlanCore: typeof PlanCore === 'undefined' ? null : PlanCore })`, ctx);
  api.ctx = ctx;
  return api;
}
