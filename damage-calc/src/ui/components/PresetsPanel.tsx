import { useMemo, useState, type Dispatch } from 'react';
import { calculate } from '../../engine/attack';
import type { AttackResult, CalcInput } from '../../engine/types';
import { fmtInt, fmtSignedPct } from '../format';
import type { Action } from '../state';
import { loadPresets, savePresets, type Preset } from '../storage';
import { Panel } from './common';

const metric = (r: AttackResult) => (r.type === 'normal' ? r.perTurn ?? r.perHit.mean : r.perHit.mean);

export function PresetsPanel({ input, dispatch, notify }: { input: CalcInput; dispatch: Dispatch<Action>; notify: (msg: string) => void }) {
  const [presets, setPresets] = useState<Preset[]>(loadPresets);
  const [name, setName] = useState('');
  const [pick, setPick] = useState<{ a: number | null; b: number | null }>({ a: null, b: null });

  const persist = (list: Preset[]) => {
    if (savePresets(list)) setPresets(list);
    else notify('保存できませんでした（ブラウザの保存領域が使えない設定かもしれません）');
  };

  const save = () => {
    const n = name.trim() || `プリセット${presets.length + 1}`;
    persist([...presets.filter((p) => p.name !== n), { name: n, savedAt: new Date().toISOString(), input }]);
    setName('');
    notify(`「${n}」を保存しました`);
  };

  const pa = pick.a !== null ? presets[pick.a] : undefined;
  const pb = pick.b !== null ? presets[pick.b] : undefined;
  const compare = useMemo(() => {
    if (!pa || !pb) return null;
    const ra = calculate(pa.input);
    const rb = calculate(pb.input);
    return ra.map((x) => ({ a: x, b: rb.find((y) => y.attackId === x.attackId) ?? rb.find((y) => y.type === x.type) }));
  }, [pa, pb]);

  return (
    <Panel id="panel-p" step="P" title="プリセット（保存と比較）">
      <div className="row-actions">
        <input aria-label="プリセット名" placeholder="名前（例: 風マグナ 渾身）" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="button" className="btn primary" onClick={save}>
          いまの入力を保存
        </button>
      </div>
      <p className="note">このブラウザにだけ保存されます（スクショ画像は保存しません）。2つ選ぶと結果を並べて比較できます。</p>
      {presets.length === 0 ? <p className="empty">保存したプリセットはありません。</p> : null}
      {presets.length > 0 ? (
        <table className="data presets">
          <thead>
            <tr>
              <th scope="col">A</th>
              <th scope="col">B</th>
              <th scope="col">名前</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {presets.map((p, i) => (
              <tr key={p.name}>
                <td>
                  <input type="radio" name="preset-a" aria-label={`${p.name} を A に`} checked={pick.a === i} onChange={() => setPick({ ...pick, a: i })} />
                </td>
                <td>
                  <input type="radio" name="preset-b" aria-label={`${p.name} を B に`} checked={pick.b === i} onChange={() => setPick({ ...pick, b: i })} />
                </td>
                <td>{p.name}</td>
                <td className="actions">
                  <button type="button" className="btn small" onClick={() => dispatch({ type: 'loadInput', input: p.input })}>
                    読み込む
                  </button>
                  <button
                    type="button"
                    className="icon"
                    aria-label={`${p.name} を削除`}
                    onClick={() => {
                      persist(presets.filter((_, j) => j !== i));
                      setPick({ a: null, b: null });
                    }}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {compare && pa && pb ? (
        <table className="data">
          <caption>
            A「{pa.name}」と B「{pb.name}」の比較（通常攻撃は1ターン、ほかは1ヒットの期待値）
          </caption>
          <thead>
            <tr>
              <th scope="col">攻撃</th>
              <th scope="col" className="num">A</th>
              <th scope="col" className="num">B</th>
              <th scope="col" className="num">B / A</th>
            </tr>
          </thead>
          <tbody>
            {compare.map(({ a, b }) => (
              <tr key={a.attackId}>
                <th scope="row">{a.name}</th>
                <td className="tnum">{fmtInt(metric(a))}</td>
                <td className="tnum">{b ? fmtInt(metric(b)) : '—'}</td>
                <td className="tnum">{b && metric(a) > 0 ? fmtSignedPct(metric(b) / metric(a) - 1) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </Panel>
  );
}
