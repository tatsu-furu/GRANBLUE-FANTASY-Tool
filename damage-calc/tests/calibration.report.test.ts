// キャリブレーションのレポート（npm run report:calibration）。合否判定はせず、仮説探索の上位と誤差を出力する。
// fixtures/panel-001.json の baseAtk が埋まっていれば順算の誤差も出す。
import { it } from 'vitest';
import expected from '../fixtures/panel-001.json';
import { SEARCH_FLAGS, forwardCheck, searchHypotheses } from '../src/engine/calibrate';
import { defaultData } from '../src/engine/data';
import { defaultInput } from '../src/engine/defaults';
import { panelFromExpected } from '../src/engine/sample';
import type { Element } from '../src/engine/types';

const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(3)}%`);

it('panel-001 の仮説探索レポート', () => {
  const panel = panelFromExpected(expected, defaultData.labels);
  const base = defaultInput();
  const baseAtk = typeof expected.baseAtk === 'number' ? expected.baseAtk : 0;
  const input = { ...base, panel, character: { ...base.character, baseAtk } };
  const vs = expected.estimate.vsElement;
  const target = { plain: expected.estimate.plain, vsElement: { element: vs.element as Element, value: vs.value } };

  const lines: string[] = ['', `== panel-001: 無印 ${target.plain} / 対${vs.element} ${vs.value} ==`];
  if (baseAtk > 0) {
    const f = forwardCheck(input, target);
    lines.push(`順算（基礎攻撃力 ${baseAtk}、既定の仮定）: 無印 ${f.plainPredicted} (${pct(f.plainError)}) / 対属性 ${f.vsPredicted} (${pct(f.vsError)})`);
  } else {
    lines.push('基礎攻撃力が未記入のため順算は省略（fixtures/panel-001.json の baseAtk を埋めると出ます）');
  }
  lines.push(`仮説探索（未知数: 基礎攻撃力、${SEARCH_FLAGS.join(' / ')} + 丸め）上位10件:`);
  for (const [i, r] of searchHypotheses(input, target, 'baseAtk').slice(0, 10).entries()) {
    const flags = SEARCH_FLAGS.map((k) => (r.assumptions[k] ? '1' : '0')).join('');
    lines.push(
      `${String(i + 1).padStart(2)}. ${flags} ${r.assumptions.roundingMode.padEnd(5)} 基礎攻撃力=${r.solvedValue?.toFixed(1) ?? '—'} 対属性=${r.vsPredicted ?? '—'} 誤差=${pct(r.vsError)}`,
    );
  }
  console.log(lines.join('\n'));
});
