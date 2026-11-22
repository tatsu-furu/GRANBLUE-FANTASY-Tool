// 計算（kosenjou-schedule.js）を、ブラウザなしで Node から呼ぶための部品。
// 画面のページと同じファイルを、vm の中で読み込む（討伐データの DIFFS は、いまはページの中にあるので、そこから取り出す）。
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { root } from './lib.mjs';

const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

/** kosenjou.html の中の `const DIFFS = [ ... ];` の文を取り出す */
function diffsSource() {
  const html = read('kosenjou.html');
  const i = html.indexOf('const DIFFS = [');
  const j = html.indexOf('\n];', i);
  if (i < 0 || j < 0) throw new Error('DIFFS が見つかりません');
  return html.slice(i, j + 3);
}

/** 計算を読み込んで、使う関数を返す。opts.performance … 時計の差し替え（時間に左右されないことの確認用） */
export function loadEngine(opts = {}) {
  const ctx = vm.createContext({ performance: opts.performance || performance, console });
  vm.runInContext(diffsSource(), ctx, { filename: 'DIFFS' });
  vm.runInContext(read('kosenjou-schedule.js'), ctx, { filename: 'kosenjou-schedule.js' });
  const api = vm.runInContext(`({ DIFFS, PHASES, DAY_MAX_HOURS, usableIn, simplexMax, ilpMax, planSchedule, allowedDiffs, scheduleHoursSpec, solveSchedule, scheduleUsage, hoursByDiff, scheduleScenario,
    verifyPlan: typeof verifyPlan === 'function' ? verifyPlan : null })`, ctx);
  api.ctx = ctx;
  // 画面側（planDiffsFrom）と同じ作り方
  api.HELL_DIFFS = api.DIFFS.filter((d) => d.isMeat || d.is250);
  api.planDiffsFrom = (times, estimatedIds = []) => api.HELL_DIFFS.map((d) => ({ id: d.id, name: d.name, tier: parseInt(d.name, 10), contrib: d.contrib, chunks: d.chunks, is250: d.is250, time: times[d.id] || null, estimated: estimatedIds.includes(d.id) }));
  return api;
}
