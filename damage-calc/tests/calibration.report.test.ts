// キャリブレーションのレポート（npm run report:calibration）。合否判定はせず、仮説探索の上位と誤差を出力する。
// fixtures/panel-*.json の baseAtk（または表示攻撃力 displayAtk）があれば、その値での順算も全仮説で並べる。
import { it } from 'vitest';
import p1 from '../fixtures/panel-001.json';
import p2 from '../fixtures/panel-002.json';
import p3 from '../fixtures/panel-003.json';
import p4 from '../fixtures/panel-004.json';
import { SEARCH_FLAGS, forwardCheck, hypothesisSpace, searchHypotheses } from '../src/engine/calibrate';
import { defaultData } from '../src/engine/data';
import { defaultInput } from '../src/engine/defaults';
import { panelFromExpected, type ExpectedPanel } from '../src/engine/sample';
import type { Element } from '../src/engine/types';

const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(3)}%`);
const fixtures: [string, ExpectedPanel & { displayAtk?: number }][] = [
  ['panel-001', p1 as ExpectedPanel],
  ['panel-002', p2 as ExpectedPanel & { displayAtk?: number }],
  ['panel-003', p3 as ExpectedPanel & { displayAtk?: number }],
  ['panel-004', p4 as ExpectedPanel & { displayAtk?: number }],
];

it('仮説探索レポート', () => {
  const lines: string[] = [];
  for (const [name, fx] of fixtures) {
    const panel = panelFromExpected(fx, defaultData.labels);
    const base = defaultInput();
    const est = fx.estimate!;
    const vs = est.vsElement!;
    const target = { plain: est.plain, vsElement: { element: vs.element as Element, value: vs.value } };
    const input = { ...base, panel };
    lines.push('', `== ${name}: 無印 ${target.plain} / 対${vs.element} ${vs.value} ==`);
    const flags = (a: typeof base.assumptions) => `${SEARCH_FLAGS.map((k) => (a[k] ? '1' : '0')).join('')} ${a.roundingMode.padEnd(5)}`;
    lines.push(`逆算（未知数: 基礎攻撃力）上位5件 [${SEARCH_FLAGS.join(' / ')}]:`);
    for (const r of searchHypotheses(input, target, 'baseAtk').slice(0, 5)) {
      lines.push(`  ${flags(r.assumptions)} 基礎攻撃力=${r.solvedValue?.toFixed(1)} 対属性誤差=${pct(r.vsError)}`);
    }
    for (const atk of [fx.baseAtk, fx.displayAtk].filter((x): x is number => typeof x === 'number')) {
      const withAtk = { ...input, character: { ...input.character, baseAtk: atk } };
      const rs = hypothesisSpace(withAtk.assumptions)
        .map((a) => forwardCheck({ ...withAtk, assumptions: a }, target))
        .sort((x, y) => Math.hypot(x.plainError!, x.vsError!) - Math.hypot(y.plainError!, y.vsError!));
      lines.push(`順算（攻撃力 ${atk}）誤差の小さい順 上位3件:`);
      for (const r of rs.slice(0, 3)) lines.push(`  ${flags(r.assumptions)} 無印 ${pct(r.plainError)} / 対属性 ${pct(r.vsError)}`);
    }
  }
  console.log(lines.join('\n'));
});
