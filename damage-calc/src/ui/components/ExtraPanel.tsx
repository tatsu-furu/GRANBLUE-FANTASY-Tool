import type { Dispatch } from 'react';
import { defaultData } from '../../engine/data';
import { ATTACK_TYPES, type AttackSpec, type AttackType, type CalcInput, type CapTable, type Modifier, type ModifierKind } from '../../engine/types';
import type { Action } from '../state';
import { NumInput, Panel, Segmented } from './common';

const frames = defaultData.frames.frames;
const softcaps = defaultData.softcaps;

const TYPE_NAME: Record<AttackType, string> = { normal: '通常', ca: '奥義', skill: 'アビ' };

export const KIND_OPTIONS: { value: ModifierKind; label: string; unit: '%' | '固定' }[] = [
  { value: 'atk', label: '攻撃力（枠を選ぶ）', unit: '%' },
  { value: 'capUp', label: '上限UP', unit: '%' },
  { value: 'capPen', label: '上限突破', unit: '%' },
  { value: 'amp', label: '与ダメUP', unit: '%' },
  { value: 'supp', label: '与ダメ上昇', unit: '固定' },
  { value: 'da', label: 'DA確率', unit: '%' },
  { value: 'ta', label: 'TA確率', unit: '%' },
  { value: 'crit', label: 'クリティカル（倍率）', unit: '%' },
  { value: 'echo', label: '追撃', unit: '%' },
  { value: 'caDmg', label: '奥義ダメUP', unit: '%' },
  { value: 'skillDmg', label: 'アビダメUP', unit: '%' },
  { value: 'defDown', label: '防御DOWN（敵）', unit: '%' },
  { value: 'defDownUnique', label: '特殊防御DOWN（敵）', unit: '%' },
  { value: 'defUp', label: '防御UP（敵）', unit: '%' },
];

const TYPED_KINDS: ModifierKind[] = ['atk', 'capUp', 'capPen', 'amp', 'supp', 'crit'];

let seq = 0;
const newId = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`;

interface Template {
  label: string;
  make: () => Omit<Modifier, 'id'>;
}

const all: AttackType[] = [...ATTACK_TYPES];
const buff = (m: Partial<Modifier> & Pick<Modifier, 'kind' | 'label' | 'value'>): Omit<Modifier, 'id'> => ({
  source: 'buff',
  appliesTo: all,
  enabled: true,
  ...m,
});

export const TEMPLATES: Template[] = [
  { label: '攻撃UP（通常枠）', make: () => buff({ kind: 'atk', frame: 'normal', label: '攻撃UP', value: 20 }) },
  { label: '攻撃UP（別枠・1つごとに乗算）', make: () => buff({ kind: 'atk', frame: 'unique', label: '別枠攻撃UP', value: 20 }) },
  { label: '属性攻撃UP', make: () => buff({ kind: 'atk', frame: 'element', label: '属性攻撃UP', value: 20 }) },
  { label: '累積攻撃UP', make: () => buff({ kind: 'atk', frame: 'unique_stackable', label: '累積攻撃UP', value: 10 }) },
  { label: '永続枠攻撃UP', make: () => buff({ kind: 'atk', frame: 'perpetuity', label: '永続枠', value: 10 }) },
  { label: 'キャラ渾身（EMP・指輪）', make: () => buff({ kind: 'atk', frame: 'char_stamina', label: 'キャラ渾身', value: 10, source: 'manual' }) },
  { label: 'キャラ背水（EMP・指輪）', make: () => buff({ kind: 'atk', frame: 'char_enmity', label: 'キャラ背水', value: 10, source: 'manual' }) },
  { label: '団スキル 攻撃力UP', make: () => buff({ kind: 'atk', frame: 'crew', label: '団スキル', value: 3, source: 'manual' }) },
  { label: '攻撃DOWN（被デバフ）', make: () => buff({ kind: 'atk', frame: 'atk_down', label: '攻撃DOWN', value: -25 }) },
  { label: '上限UP（汎用）', make: () => buff({ kind: 'capUp', label: '上限UP', value: 10 }) },
  { label: '上限UP（通常攻撃）', make: () => buff({ kind: 'capUp', label: '通常上限UP', value: 10, appliesTo: ['normal'] }) },
  { label: '上限UP（奥義）', make: () => buff({ kind: 'capUp', label: '奥義上限UP', value: 10, appliesTo: ['ca'] }) },
  { label: '上限UP（アビ）', make: () => buff({ kind: 'capUp', label: 'アビ上限UP', value: 10, appliesTo: ['skill'] }) },
  { label: '上限突破', make: () => buff({ kind: 'capPen', label: '上限突破', value: 5 }) },
  { label: '与ダメUP', make: () => buff({ kind: 'amp', label: '与ダメUP', value: 10, condition: 'always', seraphic: false }) },
  { label: '与ダメUP（天司系）', make: () => buff({ kind: 'amp', label: '天司系与ダメUP', value: 10, condition: 'always', seraphic: true }) },
  { label: '与ダメ上昇', make: () => buff({ kind: 'supp', label: '与ダメ上昇', value: 10_000, appliesTo: ['normal', 'ca'] }) },
  { label: 'DA確率UP', make: () => buff({ kind: 'da', label: 'DA確率UP', value: 20, appliesTo: ['normal'] }) },
  { label: 'TA確率UP', make: () => buff({ kind: 'ta', label: 'TA確率UP', value: 20, appliesTo: ['normal'] }) },
  { label: 'クリティカル', make: () => buff({ kind: 'crit', label: 'クリティカル', value: 50, critRate: 50, appliesTo: ['normal', 'skill'] }) },
  { label: '追撃', make: () => buff({ kind: 'echo', label: '追撃', value: 20, appliesTo: ['normal'] }) },
  { label: '奥義ダメUP（バフ）', make: () => buff({ kind: 'caDmg', label: '奥義ダメUP', value: 20, appliesTo: ['ca'], caDmgGroup: 'buff' }) },
  { label: 'アビダメUP', make: () => buff({ kind: 'skillDmg', label: 'アビダメUP', value: 20, appliesTo: ['skill'] }) },
  { label: '防御DOWN（敵）', make: () => buff({ kind: 'defDown', label: '防御DOWN', value: 25 }) },
  { label: '特殊防御DOWN（敵）', make: () => buff({ kind: 'defDownUnique', label: '特殊防御DOWN', value: 10 }) },
  { label: '防御UP（敵）', make: () => buff({ kind: 'defUp', label: '防御UP', value: 25 }) },
];

function ModifierRow({ m, dispatch }: { m: Modifier; dispatch: Dispatch<Action> }) {
  const update = (patch: Partial<Modifier>) => dispatch({ type: 'updateBuff', id: m.id, patch });
  const kindDef = KIND_OPTIONS.find((k) => k.value === m.kind);
  return (
    <div className={`mod-row${m.enabled ? '' : ' disabled'}`}>
      <div className="mod-main">
        <input type="checkbox" aria-label="有効" checked={m.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
        <input className="mod-name" aria-label="名前" value={m.label} onChange={(e) => update({ label: e.target.value })} />
        <select aria-label="種類" value={m.kind} onChange={(e) => update({ kind: e.target.value as ModifierKind, ...(e.target.value === 'atk' && !m.frame ? { frame: 'normal' } : {}) })}>
          {KIND_OPTIONS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
        <span className="mod-value">
          <NumInput label="値" size="s" value={m.value} onChange={(v) => update({ value: v ?? 0 })} />
          <span className="unit">{kindDef?.unit === '固定' ? '' : '%'}</span>
        </span>
        <button type="button" className="icon" aria-label="削除" onClick={() => dispatch({ type: 'removeBuff', id: m.id })}>
          ✕
        </button>
      </div>
      <div className="mod-sub">
        {m.kind === 'atk' ? (
          <select aria-label="枠" value={m.frame ?? 'normal'} onChange={(e) => update({ frame: e.target.value })}>
            {frames.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        ) : null}
        {m.kind === 'crit' ? (
          <span className="inline">
            発生率
            <NumInput label="発生率" size="xs" value={m.critRate ?? 0} onChange={(v) => update({ critRate: v ?? 0 })} />%
          </span>
        ) : null}
        {m.kind === 'caDmg' ? (
          <select aria-label="奥義ダメUPの種類" value={m.caDmgGroup ?? 'buff'} onChange={(e) => update({ caDmgGroup: e.target.value as 'weapon' | 'buff' })}>
            <option value="buff">バフ</option>
            <option value="weapon">武器</option>
          </select>
        ) : null}
        {TYPED_KINDS.includes(m.kind) ? (
          <span className="inline targets" role="group" aria-label="対象">
            {ATTACK_TYPES.map((t) => (
              <label key={t}>
                <input
                  type="checkbox"
                  checked={m.appliesTo.includes(t)}
                  onChange={(e) =>
                    update({ appliesTo: e.target.checked ? ATTACK_TYPES.filter((x) => x === t || m.appliesTo.includes(x)) : m.appliesTo.filter((x) => x !== t) })
                  }
                />
                {TYPE_NAME[t]}
              </label>
            ))}
          </span>
        ) : null}
        {m.kind === 'amp' ? (
          <label className="inline">
            <input type="checkbox" checked={m.seraphic ?? false} onChange={(e) => update({ seraphic: e.target.checked })} />
            天司系
          </label>
        ) : null}
        {m.kind === 'amp' || m.kind === 'supp' || m.kind === 'atk' ? (
          <label className="inline">
            <input
              type="checkbox"
              checked={m.condition === 'vsAdvantage'}
              onChange={(e) => update({ condition: e.target.checked ? 'vsAdvantage' : 'always' })}
            />
            有利属性のみ
          </label>
        ) : null}
        <select aria-label="種別" value={m.source === 'manual' ? 'manual' : 'buff'} onChange={(e) => update({ source: e.target.value as 'buff' | 'manual' })}>
          <option value="buff">戦闘中のバフ</option>
          <option value="manual">常時（EMP・指輪など）</option>
        </select>
      </div>
    </div>
  );
}

function CapTableEditor({ cap, onChange }: { cap: CapTable | undefined; onChange: (c: CapTable | undefined) => void }) {
  const t = cap ?? { thresholds: [], reductions: [0] };
  const setT = (i: number, v: number | null) => onChange({ ...t, thresholds: t.thresholds.map((x, j) => (j === i ? v ?? 0 : x)) });
  const setR = (i: number, v: number | null) => onChange({ ...t, reductions: t.reductions.map((x, j) => (j === i ? v ?? 0 : x)) });
  const add = () => {
    const last = t.thresholds[t.thresholds.length - 1];
    onChange({ thresholds: [...t.thresholds, last ? Math.round(last * 1.2) : 1_000_000], reductions: [...t.reductions, t.reductions[t.reductions.length - 1] ?? 0] });
  };
  const remove = () => {
    if (t.thresholds.length === 0) return;
    const thresholds = t.thresholds.slice(0, -1);
    onChange(thresholds.length === 0 ? undefined : { thresholds, reductions: t.reductions.slice(0, -1) });
  };
  return (
    <div className="cap-editor">
      {t.thresholds.length === 0 ? <p className="note">減衰表が未入力です（減衰なしで計算）。閾値を追加して入力してください。</p> : null}
      <table>
        <thead>
          <tr>
            <th scope="col">区間</th>
            <th scope="col">減衰前ダメージ</th>
            <th scope="col">減衰率</th>
          </tr>
        </thead>
        <tbody>
          {t.reductions.map((r, i) => (
            <tr key={i}>
              <td>{i + 1}</td>
              <td>
                {i === 0 ? '0' : null}
                {i > 0 ? <span className="tnum">{(t.thresholds[i - 1] ?? 0).toLocaleString('ja-JP')}</span> : null} 〜{' '}
                {i < t.thresholds.length ? <NumInput label={`閾値${i + 1}`} size="m" value={t.thresholds[i]} onChange={(v) => setT(i, v)} /> : null}
              </td>
              <td>
                <NumInput label={`区間${i + 1}の減衰率`} size="xs" value={r} onChange={(v) => setR(i, v)} />%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row-actions">
        <button type="button" className="btn ghost small" onClick={add}>
          ＋ 閾値を追加
        </button>
        <button type="button" className="btn ghost small" onClick={remove} disabled={t.thresholds.length === 0}>
          − 最後の閾値を削除
        </button>
      </div>
    </div>
  );
}

function AttackEditor({ a, dispatch, removable }: { a: AttackSpec; dispatch: Dispatch<Action>; removable: boolean }) {
  const update = (patch: Partial<AttackSpec>) => dispatch({ type: 'updateAttack', id: a.id, patch });
  const tables = Object.entries(softcaps.tables).filter(([, t]) => t.attackType === a.type);
  const presets = a.type === 'skill' ? Object.entries(softcaps.skillPresets) : [];
  const canCrit = a.canCrit ?? defaultData.formula.critical.defaultCanCrit[a.type];
  return (
    <div className={`attack-row${a.enabled === false ? ' disabled' : ''}`}>
      <div className="mod-main">
        <input type="checkbox" aria-label="計算する" checked={a.enabled !== false} onChange={(e) => update({ enabled: e.target.checked })} />
        <input className="mod-name" aria-label="名前" value={a.name} onChange={(e) => update({ name: e.target.value })} />
        <span className="tag">{TYPE_NAME[a.type]}</span>
        {a.type !== 'normal' ? (
          <span className="mod-value">
            倍率
            <NumInput label="倍率" size="s" value={a.multiplier} onChange={(v) => update({ multiplier: v ?? 0 })} />%
          </span>
        ) : null}
        {removable ? (
          <button type="button" className="icon" aria-label="削除" onClick={() => dispatch({ type: 'removeAttack', id: a.id })}>
            ✕
          </button>
        ) : null}
      </div>
      <div className="mod-sub">
        <select aria-label="減衰表" value={a.capTableKey} onChange={(e) => update({ capTableKey: e.target.value })}>
          {tables.map(([k, t]) => (
            <option key={k} value={k}>
              減衰: {t.name}
            </option>
          ))}
          {presets.map(([k, p]) => (
            <option key={k} value={k}>
              減衰: {p.name}
              {p.thresholds ? '' : '（表が未転記）'}
            </option>
          ))}
          <option value="custom">減衰: 技ごとに入力</option>
        </select>
        {a.type === 'ca' ? (
          <span className="inline">
            固定値
            <NumInput label="奥義の固定値" size="s" value={a.fixedDamage ?? 0} onChange={(v) => update({ fixedDamage: v ?? 0 })} />
          </span>
        ) : null}
        <label className="inline">
          <input type="checkbox" checked={canCrit} onChange={(e) => update({ canCrit: e.target.checked })} />
          クリティカルする
        </label>
      </div>
      {a.capTableKey === 'custom' ? <CapTableEditor cap={a.customCap} onChange={(c) => update({ customCap: c })} /> : null}
      {softcaps.skillPresets[a.capTableKey] && !softcaps.skillPresets[a.capTableKey]!.thresholds ? (
        <p className="note">
          このプリセットは減衰表がまだ data/softcaps.json に転記されていません（目安: 倍率 {softcaps.skillPresets[a.capTableKey]!.multiplier}%・上限 約
          {softcaps.skillPresets[a.capTableKey]!.approxCap?.toLocaleString('ja-JP')}）。
        </p>
      ) : null}
    </div>
  );
}

export function ExtraPanel({ input, dispatch }: { input: CalcInput; dispatch: Dispatch<Action> }) {
  const { character, enemy } = input;
  const presets = defaultData.formula.defense.presets;
  const skills = input.attacks.filter((a) => a.type === 'skill');
  return (
    <Panel id="panel-c" step="C" title="追加入力（パネルに出ない値）">
      <h3 className="group-title">キャラ</h3>
      <div className="fields">
        <label className="field">
          <span>基礎攻撃力</span>
          <NumInput label="基礎攻撃力" value={character.baseAtk} onChange={(v) => dispatch({ type: 'patchCharacter', patch: { baseAtk: v ?? 0 } })} />
          <span className="hint">分からなければ E のキャリブレーションで逆算できます</span>
        </label>
        <div className="field">
          <span>属性の相性</span>
          <Segmented
            label="属性の相性"
            value={character.elementRelation}
            options={[
              { value: 'advantage', label: '有利' },
              { value: 'neutral', label: '等倍' },
              { value: 'disadvantage', label: '不利' },
            ]}
            onChange={(v) => dispatch({ type: 'patchCharacter', patch: { elementRelation: v } })}
          />
        </div>
        <label className="field">
          <span>基礎 DA 率（%）</span>
          <NumInput label="基礎DA率" size="s" value={character.baseDA} onChange={(v) => dispatch({ type: 'patchCharacter', patch: { baseDA: v ?? 0 } })} />
        </label>
        <label className="field">
          <span>基礎 TA 率（%）</span>
          <NumInput label="基礎TA率" size="s" value={character.baseTA} onChange={(v) => dispatch({ type: 'patchCharacter', patch: { baseTA: v ?? 0 } })} />
        </label>
      </div>

      <h3 className="group-title">敵</h3>
      <div className="fields">
        <div className="field">
          <span>基礎防御</span>
          <span className="inline">
            <Segmented
              label="基礎防御のプリセット"
              value={presets.includes(enemy.baseDef) ? String(enemy.baseDef) : ''}
              options={presets.map((p) => ({ value: String(p), label: String(p) }))}
              onChange={(v) => dispatch({ type: 'patchEnemy', patch: { baseDef: Number(v) } })}
            />
            <NumInput label="基礎防御" size="xs" value={enemy.baseDef} onChange={(v) => dispatch({ type: 'patchEnemy', patch: { baseDef: v && v > 0 ? v : 10 } })} />
          </span>
        </div>
        <label className="field">
          <span>特殊上限（バトルごと）</span>
          <select value={enemy.specialCap} onChange={(e) => dispatch({ type: 'patchEnemy', patch: { specialCap: e.target.value as CalcInput['enemy']['specialCap'] } })}>
            {Object.entries(softcaps.specialCaps).map(([k, c]) => (
              <option key={k} value={k}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <h3 className="group-title">バフ・デバフ・常時補正</h3>
      {input.buffs.length === 0 ? <p className="empty">なし（下のテンプレートから追加）</p> : null}
      {input.buffs.map((m) => (
        <ModifierRow key={m.id} m={m} dispatch={dispatch} />
      ))}
      <select
        className="add-select"
        aria-label="テンプレートから追加"
        value=""
        onChange={(e) => {
          const t = TEMPLATES[Number(e.target.value)];
          if (t) dispatch({ type: 'addBuff', buff: { id: newId(), ...t.make() } });
        }}
      >
        <option value="">＋ テンプレートから追加…</option>
        {TEMPLATES.map((t, i) => (
          <option key={t.label} value={i}>
            {t.label}
          </option>
        ))}
      </select>

      <h3 className="group-title">計算する攻撃</h3>
      {input.attacks.map((a) => (
        <AttackEditor key={a.id} a={a} dispatch={dispatch} removable={a.type === 'skill'} />
      ))}
      <button
        type="button"
        className="btn ghost"
        onClick={() =>
          dispatch({
            type: 'addAttack',
            attack: {
              id: `skill-${newId()}`,
              name: `アビリティ${skills.length + 1}`,
              type: 'skill',
              multiplier: defaultData.formula.attackDefaults.skillMultiplier,
              capTableKey: 'custom',
              enabled: true,
            },
          })
        }
      >
        ＋ アビを追加
      </button>
    </Panel>
  );
}
