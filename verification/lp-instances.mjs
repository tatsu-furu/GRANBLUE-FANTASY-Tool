// 単体法（右辺が負の式つき＝2段階法を含む）を、ランダムな線形計画 600問で動かして、答えを出す（厳密解法との照合用）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEngine } from '../tests/engine.mjs';

const OUT = process.env.OUT || path.join(path.dirname(fileURLToPath(import.meta.url)), 'out', 'lp-instances.json');
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const E = loadEngine();
let a = 12345;
const rnd = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const out = [];
for (let k = 0; k < 600; k++) {
  const n = int(2, 7), m = int(2, 8);
  const c = Array.from({ length: n }, () => int(0, 9));
  const A = Array.from({ length: m }, () => Array.from({ length: n }, () => (rnd() < 0.35 ? 0 : int(-5, 9))));
  const b = Array.from({ length: m }, () => (rnd() < 0.3 ? -int(1, 20) : int(0, 40)));
  if (k % 3 === 0) A.push(Array.from({ length: n }, () => 1)), b.push(int(10, 60));   // 上限をつける（上限なしの問題だけにならないように）
  const r = E.simplexMax(c, A, b);
  out.push({ c, A, b, status: r.infeasible ? 'infeasible' : r.unbounded ? 'unbounded' : 'optimal', value: r.value ?? null, x: r.x ?? null });
}
fs.writeFileSync(OUT, JSON.stringify(out));
const cnt = (s) => out.filter((x) => x.status === s).length;
console.log(`線形計画 ${out.length}問：解あり ${cnt('optimal')}・解なし ${cnt('infeasible')}・上限なし ${cnt('unbounded')}`);
