import { useState } from 'react';
import { defaultData } from '../../engine/data';
import { resolveCapTable } from '../../engine/softcap';
import type { AttackResult, AttackSpec, CalcInput } from '../../engine/types';
import { fmtInt, fmtMult, fmtPct, fmtSignedPct } from '../format';
import { Panel, Warnings } from './common';
import { SoftCapChart } from './SoftCapChart';

const TYPE_NAME = { normal: '通常攻撃', ca: '奥義', skill: 'アビリティ' } as const;
const frames = defaultData.frames.frames;

function Breakdown({ r, input }: { r: AttackResult; input: CalcInput }) {
  const b = r.perHit.breakdown;
  const suppAmplified = r.type !== 'normal';
  const rows: [string, string, string?][] = [
    ['基礎攻撃力', fmtInt(input.character.baseAtk)],
    ['× 技の倍率', fmtMult(b.multiplier), r.type === 'ca' ? '奥義ダメUP込み' : r.type === 'skill' ? 'アビダメUP込み' : undefined],
    ['× 攻撃力の枠の積', fmtMult(frames.reduce((p, f) => p * (b.frames[f.id] ?? 1), 1))],
    ['= 防御で割る前', fmtInt(b.raw)],
    ['÷ 実効防御', b.defEff.toFixed(2)],
    ['= 減衰前', fmtInt(b.afterDef), r.type === 'ca' && b.afterDef > 0 ? '奥義の固定値込み' : undefined],
    ['→ 減衰後', fmtInt(b.afterCap), `${b.capTableName}・上限UP ${fmtPct(b.capUp, 1)}・上限突破 ${fmtPct(b.penetration, 1)}`],
    [
      '× 与ダメUP',
      fmtMult(1 + b.ampSeraphic + b.ampOther),
      `天司系 ${fmtPct(b.ampSeraphic, 1)}（最大値1つ）+ その他 ${fmtPct(b.ampOther, 1)}`,
    ],
    ['= 与ダメUP後', fmtInt(b.afterAmp)],
    ['+ 与ダメ上昇', fmtInt(b.supp), suppAmplified ? '与ダメUP で増える' : '与ダメUP では増えない'],
    ['= 最終', fmtInt(b.final), b.specialCap ? `特殊上限 ${fmtInt(b.specialCap)}` : undefined],
  ];
  return (
    <table className="data breakdown">
      <caption>乱数1.00・クリティカルなしの1ヒット</caption>
      <tbody>
        {rows.map(([k, v, note]) => (
          <tr key={k}>
            <th scope="row">{k}</th>
            <td className="tnum">{v}</td>
            <td className="note-cell">{note ?? ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FrameTable({ r }: { r: AttackResult }) {
  const [showAll, setShowAll] = useState(false);
  const b = r.perHit.breakdown;
  const rows = frames.filter((f) => showAll || Math.abs((b.frames[f.id] ?? 1) - 1) > 1e-9);
  const metric = r.type === 'normal' ? '1ターン期待値' : '1ヒット期待値';
  return (
    <>
      <table className="data">
        <caption>各枠に +{defaultData.formula.marginalStep}% したときの{metric}の伸び（減衰込み）</caption>
        <thead>
          <tr>
            <th scope="col">枠</th>
            <th scope="col" className="num">倍率</th>
            <th scope="col" className="num">+{defaultData.formula.marginalStep}% で</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => (
            <tr key={f.id}>
              <th scope="row">{f.name}</th>
              <td className="tnum">{fmtMult(b.frames[f.id] ?? 1)}</td>
              <td className="tnum">{fmtSignedPct(r.marginal[f.id] ?? 0)}</td>
            </tr>
          ))}
          <tr className="sep">
            <th scope="row">上限UP</th>
            <td className="tnum">{fmtPct(b.capUp, 1)}</td>
            <td className="tnum">{fmtSignedPct(r.marginalExtra.capUp)}</td>
          </tr>
          <tr>
            <th scope="row">与ダメUP</th>
            <td className="tnum">{fmtPct(b.ampSeraphic + b.ampOther, 1)}</td>
            <td className="tnum">{fmtSignedPct(r.marginalExtra.amp)}</td>
          </tr>
        </tbody>
      </table>
      <button type="button" className="btn ghost small" onClick={() => setShowAll((v) => !v)}>
        {showAll ? '倍率1.0の枠を隠す' : 'すべての枠を表示'}
      </button>
    </>
  );
}

function ResultCard({ r, attack, input }: { r: AttackResult; attack: AttackSpec | undefined; input: CalcInput }) {
  const b = r.perHit.breakdown;
  const cap = attack ? resolveCapTable(attack, defaultData) : null;
  const headline = r.type === 'normal' ? r.perTurn ?? r.perHit.mean : r.perHit.mean;
  return (
    <article className="result-card">
      <header>
        <h3>{r.name}</h3>
        <span className="tag">{TYPE_NAME[r.type]}</span>
      </header>
      <div className="stat">
        <span className="stat-label">{r.type === 'normal' ? '1ターンの期待値' : '1ヒットの期待値'}</span>
        <span className="stat-value">{fmtInt(headline)}</span>
      </div>
      <dl className="stats">
        {r.type === 'normal' ? (
          <div>
            <dt>1ヒットの期待値</dt>
            <dd className="tnum">{fmtInt(r.perHit.mean)}</dd>
          </div>
        ) : null}
        <div>
          <dt>乱数の幅（最小〜最大）</dt>
          <dd className="tnum">
            {fmtInt(r.perHit.min)} 〜 {fmtInt(r.perHit.max)}
          </dd>
        </div>
        {r.multiattack ? (
          <div>
            <dt>連撃</dt>
            <dd>
              {r.multiattack.hits.toFixed(3)} ヒット/ターン（TA {fmtPct(r.multiattack.pTA)}・DA {fmtPct(r.multiattack.pDA)}・単発 {fmtPct(r.multiattack.pSA)}）
            </dd>
          </div>
        ) : null}
        {r.echo ? (
          <div>
            <dt>追撃</dt>
            <dd className="tnum">
              {fmtPct(r.echo.rate, 0)}・1ヒットあたり {fmtInt(r.echo.perHitMean)}
            </dd>
          </div>
        ) : null}
        {r.critChance > 0 ? (
          <div>
            <dt>クリティカル発生率</dt>
            <dd className="tnum">{fmtPct(r.critChance)}</dd>
          </div>
        ) : null}
      </dl>
      <Warnings items={r.warnings} />
      <details>
        <summary>計算の内訳</summary>
        <Breakdown r={r} input={input} />
      </details>
      <details>
        <summary>枠ごとの倍率と +{defaultData.formula.marginalStep}% の伸び</summary>
        <FrameTable r={r} />
      </details>
      {cap?.table ? (
        <details>
          <summary>減衰グラフ</summary>
          <SoftCapChart
            table={cap.table}
            capUp={b.capUp}
            penetration={b.penetration}
            current={{ x: b.afterDef, y: b.afterCap }}
            caption={`${r.name}の減衰（${cap.name}）`}
          />
        </details>
      ) : null}
    </article>
  );
}

export function ResultsPanel({ results, input, warnings }: { results: AttackResult[]; input: CalcInput; warnings: string[] }) {
  return (
    <Panel id="panel-d" step="D" title="結果">
      <Warnings items={warnings} />
      {results.length === 0 ? <p className="empty">計算する攻撃がありません（C で有効にしてください）。</p> : null}
      {results.map((r) => (
        <ResultCard key={r.attackId} r={r} attack={input.attacks.find((a) => a.id === r.attackId)} input={input} />
      ))}
    </Panel>
  );
}
