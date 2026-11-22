// 厳密解法（HiGHS）との照合：画面の関数が出した問題を取り出し、Python（scipy の milp）で厳密に解いて、比べる。
// 使い方： npm run verify    （事前に： pip install -r verification/requirements.txt）
// 環境変数： PYTHON … Python の実行ファイル（既定 python3） / OUT_DIR … 問題の出力先（既定 verification/out）
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PY = process.env.PYTHON || 'python3';
const outDir = path.resolve(process.env.OUT_DIR || path.join(here, 'out'));
fs.mkdirSync(outDir, { recursive: true });

const run = (label, cmd, args, env = {}) => {
  console.log(`\n── ${label} ──`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  return r.status === 0;
};
const dump = (n) => run(`問題を取り出す（集合${n}）`, process.execPath, [path.join(here, `dump-instances${n === 1 ? '' : n}.mjs`)], { OUT: path.join(outDir, `instances${n === 1 ? '' : n}.json`) });
const f = (n) => path.join(outDir, `instances${n === 1 ? '' : n}.json`);
const py = (script, ...args) => [path.join(here, script), ...args];

const results = [];
const step = (name, ok) => results.push([name, ok]);

// 問題を取り出せなかったら、照合に進まない（古い出力で通ってしまうのを防ぐ）
for (const n of [1, 2, 3]) {
  const ok = dump(n);
  step(`問題を取り出す（集合${n}）`, ok);
  if (!ok) { console.log(`\n集合${n}の取り出しに失敗`); process.exit(1); }
}
step('集合1：取れる貢献度・必要な肉（必要な肉は、厳密解と完全に一致）', run('集合1：取れる貢献度・必要な肉', PY, py('exact-check.py', f(1), '--strict-req')));
step('集合2：取れる貢献度・必要な肉（素材の変換つき・ランダムな討伐時間を含む）', run('集合2：取れる貢献度・必要な肉', PY, py('exact-check.py', f(2))));
step('毎日の時間の最小性（肉・素材が十分あるとき）', run('毎日の時間の最小性（肉・素材が十分）', PY, py('exact-hours-check.py', f(1), f(2))));
step('毎日の時間の最小性（実際の肉・素材・日ごとの指定つき）', run('毎日の時間の最小性（実際の肉・素材）', PY, py('exact-hours-check-actual.py', f(3))));

console.log('\n══ まとめ ══');
results.forEach(([name, ok]) => console.log(`${ok ? 'OK  ' : 'NG  '} ${name}`));
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
