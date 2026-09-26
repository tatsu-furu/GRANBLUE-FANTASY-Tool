import { useMemo, useState, type Dispatch } from 'react';
import {
  SEARCH_FLAGS,
  UNKNOWNS,
  advantageTarget,
  calibrate,
  forwardCheck,
  searchHypotheses,
  searchHypothesesMulti,
  type CalibrationResult,
  type CalibrationTarget,
  type UnknownKey,
} from '../../engine/calibrate';
import type { Assumptions, BooleanAssumptionKey, CalcInput } from '../../engine/types';
import { fmtInt, fmtSignedPct } from '../format';
import type { Action, CalibView } from '../state';
import { Panel } from './common';
import { ELEMENT_NAMES } from './PanelForm';

const FLAG_TEXT: Record<BooleanAssumptionKey, { long: string; short: string }> = {
  panelValuesIncludeAura: { long: 'パネルの攻刃系の値は加護適用後', short: '加護込み' },
  estimateIncludesSoftCap: { long: '予測ダメージは減衰込み', short: '減衰込み' },
  estimateIncludesAmp: { long: '予測ダメージは与ダメUP込み', short: '与ダメUP込み' },
  advAmpOnlyVsAdvantage: { long: '対有利与ダメは有利属性のときだけ乗る', short: '対有利は有利のみ' },
  estimateIncludesSupp: { long: '予測ダメージは与ダメ上昇込み', short: '与ダメ上昇込み' },
  plainEstimateIsNeutral: { long: '無印の予測ダメージは属性等倍が前提', short: '無印は等倍' },
  capPenetrationActive: { long: '武器の上限UPが上限を超えた分は上限突破', short: '上限突破' },
  advAmpIsSeraphic: { long: '対有利与ダメは天司系（最大値1つだけ）', short: '対有利は天司系' },
};
const ALL_FLAGS = Object.keys(FLAG_TEXT) as BooleanAssumptionKey[];
const ROUNDING_TEXT = { final: '最終のみ切り捨て', each: '各段階で切り捨て', none: '丸めなし' } as const;

function FlagChips({ a }: { a: Assumptions }) {
  return (
    <span className="chips">
      {SEARCH_FLAGS.map((f) => (
        <span key={f} className={`chip ${a[f] ? 'on' : 'off'}`} title={FLAG_TEXT[f].long}>
          {a[f] ? '✓' : '✗'}
          {FLAG_TEXT[f].short}
        </span>
      ))}
      <span className="chip neutral">{ROUNDING_TEXT[a.roundingMode]}</span>
    </span>
  );
}

const sameFlags = (x: Assumptions, y: Assumptions) => SEARCH_FLAGS.every((f) => x[f] === y[f]) && x.roundingMode === y.roundingMode;

function fmtUnknown(key: UnknownKey, v: number | null): string {
  if (v === null) return '—';
  return UNKNOWNS[key].unit === '%' ? `${v.toFixed(2)}%` : fmtInt(v);
}

function ErrorCell({ e }: { e: number | null }) {
  if (e === null) return <td className="tnum">—</td>;
  const good = Math.abs(e) < 0.005;
  return (
    <td className={`tnum ${good ? 'err-good' : Math.abs(e) > 0.03 ? 'err-bad' : ''}`}>
      {fmtSignedPct(e)}
      {good ? ' ✓' : ''}
    </td>
  );
}

interface Props {
  input: CalcInput;
  calib: CalibView;
  dispatch: Dispatch<Action>;
}

export function CalibrationPanel({ input, calib, dispatch }: Props) {
  const [inverse, setInverse] = useState<CalibrationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const est = input.panel.estimate;
  const target: CalibrationTarget | null = est && est.plain > 0 ? { plain: est.plain, vsElement: est.vsElement } : null;
  const a = input.assumptions;
  const vsName = est?.vsElement ? ELEMENT_NAMES[est.vsElement.element] : '○';
  const elementMismatch =
    input.panel.element && est?.vsElement && advantageTarget(input.panel.element) !== est.vsElement.element
      ? `グリッドの属性（${ELEMENT_NAMES[input.panel.element]}）が有利を取れるのは${ELEMENT_NAMES[advantageTarget(input.panel.element)]}属性です。対属性の予測ダメージは有利として計算しています`
      : null;

  const forward = useMemo(() => (target && input.character.baseAtk > 0 ? forwardCheck(input, target) : null), [input, target]);

  const runLater = (fn: () => void) => {
    setBusy(true);
    setTimeout(() => {
      try {
        fn();
      } finally {
        setBusy(false);
      }
    }, 20);
  };

  const applyUnknown = (key: UnknownKey, v: number) => {
    if (key === 'baseAtk') dispatch({ type: 'patchCharacter', patch: { baseAtk: Math.round(v * 10) / 10 } });
    else
      dispatch({
        type: 'addBuff',
        buff: {
          id: `calib-${Date.now().toString(36)}`,
          label: key === 'elementAura' ? '逆算した属性枠の追加分' : '逆算した上限UP',
          source: 'manual',
          kind: key === 'elementAura' ? 'atk' : 'capUp',
          ...(key === 'elementAura' ? { frame: 'element' } : {}),
          appliesTo: key === 'elementAura' ? ['normal', 'ca', 'skill'] : ['normal'],
          value: Math.round(v * 100) / 100,
          enabled: true,
        },
      });
  };

  const applyHypothesis = (x: Assumptions, solved?: number | null) => {
    const patch: Partial<Assumptions> = { roundingMode: x.roundingMode };
    for (const f of SEARCH_FLAGS) patch[f] = x[f];
    dispatch({ type: 'patchAssumptions', patch });
    if (solved !== undefined && solved !== null && calib.unknownKey === 'baseAtk') applyUnknown('baseAtk', solved);
  };

  return (
    <Panel id="panel-e" step="E" title="キャリブレーション">
      <p className="note">
        パネルの予測ダメージは「防御10・通常攻撃1回・戦闘中バフなし」でゲームが出した値です。これを正解として、式の実装と仮定を確かめます。
      </p>
      {target ? (
        <p className="target">
          正解: 無印 <strong className="tnum">{fmtInt(target.plain)}</strong>
          {target.vsElement ? (
            <>
              ／ 対{vsName}属性 <strong className="tnum">{fmtInt(target.vsElement.value)}</strong>
            </>
          ) : null}
        </p>
      ) : (
        <p className="empty">B のヘッダに予測ダメージを入れてください。</p>
      )}
      {elementMismatch ? <p className="note warn">⚠ {elementMismatch}</p> : null}

      <h3 className="group-title">仮定（通常の計算にも使います）</h3>
      <div className="flags-grid">
        {ALL_FLAGS.map((f) => (
          <label key={f} className="check">
            <input type="checkbox" checked={a[f]} onChange={(e) => dispatch({ type: 'patchAssumptions', patch: { [f]: e.target.checked } })} />
            {FLAG_TEXT[f].long}
          </label>
        ))}
        <label className="check">
          丸め
          <select value={a.roundingMode} onChange={(e) => dispatch({ type: 'patchAssumptions', patch: { roundingMode: e.target.value as Assumptions['roundingMode'] } })}>
            {Object.entries(ROUNDING_TEXT).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          追撃の元
          <select value={a.echoBase} onChange={(e) => dispatch({ type: 'patchAssumptions', patch: { echoBase: e.target.value as Assumptions['echoBase'] } })}>
            <option value="afterCap">減衰後</option>
            <option value="afterAmp">与ダメUP後</option>
            <option value="final">最終</option>
          </select>
        </label>
      </div>

      <h3 className="group-title">1. 順算（基礎攻撃力から予測ダメージを再現）</h3>
      {forward ? (
        <table className="data">
          <thead>
            <tr>
              <th scope="col" />
              <th scope="col" className="num">計算</th>
              <th scope="col" className="num">パネル</th>
              <th scope="col" className="num">誤差</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">無印</th>
              <td className="tnum">{fmtInt(forward.plainPredicted ?? NaN)}</td>
              <td className="tnum">{fmtInt(target!.plain)}</td>
              <ErrorCell e={forward.plainError} />
            </tr>
            {target?.vsElement ? (
              <tr>
                <th scope="row">対{vsName}属性</th>
                <td className="tnum">{fmtInt(forward.vsPredicted ?? NaN)}</td>
                <td className="tnum">{fmtInt(target.vsElement.value)}</td>
                <ErrorCell e={forward.vsError} />
              </tr>
            ) : null}
          </tbody>
        </table>
      ) : (
        <p className="empty">基礎攻撃力（C）と予測ダメージ（B）を入れると表示します。</p>
      )}

      <h3 className="group-title">2. 逆算（未知数1つを無印に合わせ、対属性で答え合わせ）</h3>
      <div className="row-actions">
        <select
          aria-label="逆算する未知数"
          value={calib.unknownKey}
          onChange={(e) => {
            setInverse(null);
            dispatch({ type: 'calibUnknown', key: e.target.value as UnknownKey });
          }}
        >
          {Object.values(UNKNOWNS).map((u) => (
            <option key={u.key} value={u.key}>
              {u.label}
            </option>
          ))}
        </select>
        <button type="button" className="btn primary" disabled={!target} onClick={() => setInverse(calibrate(input, target!, calib.unknownKey))}>
          逆算する
        </button>
      </div>
      {inverse ? (
        inverse.solvedValue === null ? (
          <p className="note warn">⚠ {inverse.message}</p>
        ) : (
          <div className="inverse">
            <p>
              {UNKNOWNS[calib.unknownKey].label}: <strong className="tnum">{fmtUnknown(calib.unknownKey, inverse.solvedValue)}</strong>
              {inverse.vsPredicted !== null ? (
                <>
                  {' '}
                  → 対{vsName}属性の予測 <span className="tnum">{fmtInt(inverse.vsPredicted)}</span>（誤差 {fmtSignedPct(inverse.vsError ?? NaN)}）
                </>
              ) : null}
            </p>
            <button type="button" className="btn" onClick={() => applyUnknown(calib.unknownKey, inverse.solvedValue!)}>
              この値を入力に反映
            </button>
          </div>
        )
      ) : null}

      <h3 className="group-title">3. 仮説探索（仮定 {SEARCH_FLAGS.length} 個 × 丸め3通り）</h3>
      <div className="row-actions">
        <button
          type="button"
          className="btn primary"
          disabled={!target?.vsElement || busy}
          onClick={() => runLater(() => dispatch({ type: 'calibSearch', results: searchHypotheses(input, target!, calib.unknownKey) }))}
        >
          {busy ? '探索中…' : `全 ${2 ** SEARCH_FLAGS.length * 3} 通りを探索`}
        </button>
        {!target?.vsElement ? <span className="hint">対属性の予測ダメージも必要です</span> : null}
      </div>
      {calib.search ? (
        <div className="table-scroll">
          <table className="data hyp">
            <caption>対{vsName}属性の誤差が小さい順（上位10件）。逆算した未知数: {UNKNOWNS[calib.unknownKey].label}</caption>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">仮定</th>
                <th scope="col" className="num">逆算値</th>
                <th scope="col" className="num">対属性の予測</th>
                <th scope="col" className="num">誤差</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {calib.search.slice(0, 10).map((r, i) => (
                <tr key={i} className={sameFlags(r.assumptions, a) ? 'current' : ''}>
                  <td>{i + 1}</td>
                  <td>
                    <FlagChips a={r.assumptions} />
                    {sameFlags(r.assumptions, a) ? <span className="hint">（現在の設定）</span> : null}
                  </td>
                  <td className="tnum">{fmtUnknown(calib.unknownKey, r.solvedValue)}</td>
                  <td className="tnum">{r.vsPredicted === null ? '—' : fmtInt(r.vsPredicted)}</td>
                  <ErrorCell e={r.vsError} />
                  <td>
                    <button type="button" className="btn small" onClick={() => applyHypothesis(r.assumptions, r.solvedValue)}>
                      適用
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <h3 className="group-title">4. 複数スクショで一括（グリッド違いのサンプルをまとめて）</h3>
      <div className="row-actions">
        <button
          type="button"
          className="btn"
          disabled={!target?.vsElement}
          onClick={() =>
            dispatch({
              type: 'calibAddSample',
              sample: { id: `s${Date.now().toString(36)}`, name: `サンプル${calib.samples.length + 1}`, input, target: target! },
            })
          }
        >
          いまのパネルをサンプルに追加
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={calib.samples.length < 2 || busy}
          onClick={() => runLater(() => dispatch({ type: 'calibMulti', results: searchHypothesesMulti(calib.samples, calib.unknownKey) }))}
        >
          {calib.samples.length} 件で一括探索
        </button>
      </div>
      {calib.samples.length > 0 ? (
        <ul className="samples">
          {calib.samples.map((s) => (
            <li key={s.id}>
              {s.name}: 無印 <span className="tnum">{fmtInt(s.target.plain)}</span>
              {s.target.vsElement ? (
                <>
                  ／ 対属性 <span className="tnum">{fmtInt(s.target.vsElement.value)}</span>
                </>
              ) : null}
              <button type="button" className="icon" aria-label={`${s.name}を削除`} onClick={() => dispatch({ type: 'calibRemoveSample', id: s.id })}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {calib.multi ? (
        <div className="table-scroll">
          <table className="data hyp">
            <caption>全サンプルの対属性誤差（二乗平均平方根）が小さい順</caption>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">仮定</th>
                <th scope="col" className="num">誤差</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {calib.multi.slice(0, 10).map((r, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>
                    <FlagChips a={r.assumptions} />
                  </td>
                  <td className="tnum">{r.rmsError === null ? '逆算できないサンプルあり' : `${(r.rmsError * 100).toFixed(2)}%`}</td>
                  <td>
                    <button type="button" className="btn small" onClick={() => applyHypothesis(r.assumptions)}>
                      適用
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Panel>
  );
}
