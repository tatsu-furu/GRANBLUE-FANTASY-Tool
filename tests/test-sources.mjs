// ソースの決まりごとを確かめるテスト（ブラウザなし）。
//   ・ゲームの定数（ドロップ率の既定値など）は、コード内の1か所だけで定義されている
import fs from 'node:fs';
import path from 'node:path';
import { root } from './lib.mjs';

let fails = 0, total = 0;
const ok = (cond, msg, extra = '') => { total++; if (!cond) fails++; console.log(`${cond ? 'OK  ' : 'NG  '} ${msg}${!cond && extra ? '\n      ' + String(extra).slice(0, 600) : ''}`); };

// サイトのコード（テスト・検証・ドキュメントは除く）
const files = fs.readdirSync(root).filter((f) => /\.(js|html)$/.test(f) && !/^beta_backup/.test(f));
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const count = (re, only) => files.filter((f) => !only || only.includes(f)).map((f) => [f, (read(f).match(re) || []).length]).filter(([, n]) => n > 0);

// ── ドロップ率の既定値は、kosenjou-trehun.js の1か所だけ ──
{
  const defs = count(/\bitemRate\s*:\s*\d/g);
  ok(defs.length === 1 && defs[0][0] === 'kosenjou-trehun.js' && defs[0][1] === 1, 'ドロップ率: アイテム率の既定値（itemRate: 数）は、kosenjou-trehun.js の1か所だけで定義されている', JSON.stringify(defs));
  const box = count(/\bconst\s+BOX_BASE_BY_DIFF\s*=/g);
  ok(box.length === 1 && box[0][0] === 'kosenjou-trehun.js' && box[0][1] === 1, 'ドロップ率: 難易度ごとの箱の基本率（BOX_BASE_BY_DIFF）は、kosenjou-trehun.js の1か所だけで定義されている', JSON.stringify(box));
  const boxBase = count(/\bboxBase\s*:\s*\d/g);
  ok(boxBase.length === 1 && boxBase[0][0] === 'kosenjou-trehun.js' && boxBase[0][1] === 1, 'ドロップ率: 箱の基本率の既定値（boxBase: 数）は、kosenjou-trehun.js の1か所だけで定義されている', JSON.stringify(boxBase));
  const plan = read('kosenjou-plan.js');
  ok(!/0\.384|itemRate\s*[:=]\s*\d/.test(plan), 'ドロップ率: かんたん計画には、確率の数字を直接書いていない（トレハンタブの設定を読む）');
}

console.log(`\n${fails === 0 ? `全部 OK（${total}件）` : `${fails} 件 NG / ${total}件`}`);
process.exit(fails ? 1 : 0);
