import { useEffect, useRef, useState, type Dispatch } from 'react';
import { defaultData } from '../../engine/data';
import { slotOf } from '../../engine/modifiers';
import type { Element, LabelDef, PanelSkill, PanelValues, SlotSpec } from '../../engine/types';
import type { CellFlag, CellMeta, FieldMeta, ParseResult } from '../../ocr/parse';
import type { Action } from '../state';
import { ConfBadge, NumInput, Panel } from './common';

const labels = defaultData.labels;
const frames = defaultData.frames.frames;

export const ELEMENT_NAMES: Record<Element, string> = { fire: '火', water: '水', earth: '土', wind: '風', light: '光', dark: '闇' };
const ELEMENTS = Object.keys(ELEMENT_NAMES) as Element[];

const GROUPS: { key: string; title: string; kinds: SlotSpec['kind'][] }[] = [
  { key: 'atk', title: '攻撃力の枠', kinds: ['atk'] },
  { key: 'cap', title: '上限UP', kinds: ['capUp', 'capPen'] },
  { key: 'amp', title: '与ダメUP・与ダメ上昇', kinds: ['amp', 'supp'] },
  { key: 'multi', title: '連撃・追撃', kinds: ['da', 'ta', 'echo'] },
  { key: 'caskill', title: '奥義・アビ', kinds: ['caDmg', 'skillDmg'] },
  { key: 'display', title: '表示のみ（計算に使わない）', kinds: ['display'] },
  { key: 'unclassified', title: '未分類（枠を割り当てるまで計算に入らない）', kinds: ['unclassified'] },
];

const FLAG_TEXT: Record<CellFlag, string> = {
  unit: '単位が辞書と違う',
  range: '値が想定の範囲外',
  value: '数値として読めない',
  duplicate: '同じ項目が2回読めた',
  ambiguous: '候補が複数ある',
};

// 未分類の割り当て先（select の値 ↔ SlotSpec）
const ASSIGN_OPTIONS: { value: string; label: string; slot: SlotSpec }[] = [
  ...frames.map((f) => ({ value: `atk:${f.id}`, label: `攻撃力: ${f.name}`, slot: { kind: 'atk', frame: f.id } as SlotSpec })),
  { value: 'capUp:all', label: '上限UP（汎用）', slot: { kind: 'capUp', appliesTo: ['normal', 'ca', 'skill'] } },
  { value: 'capUp:normal', label: '上限UP（通常攻撃）', slot: { kind: 'capUp', appliesTo: ['normal'] } },
  { value: 'capUp:ca', label: '上限UP（奥義）', slot: { kind: 'capUp', appliesTo: ['ca'] } },
  { value: 'capUp:skill', label: '上限UP（アビ）', slot: { kind: 'capUp', appliesTo: ['skill'] } },
  { value: 'capPen:all', label: '上限突破', slot: { kind: 'capPen', appliesTo: ['normal', 'ca', 'skill'] } },
  { value: 'amp:all', label: '与ダメUP', slot: { kind: 'amp', appliesTo: ['normal', 'ca', 'skill'], seraphic: false, condition: 'always' } },
  { value: 'amp:seraphic', label: '与ダメUP（天司系）', slot: { kind: 'amp', appliesTo: ['normal', 'ca', 'skill'], seraphic: true, condition: 'always' } },
  { value: 'supp:normal-ca', label: '与ダメ上昇（通常・奥義）', slot: { kind: 'supp', appliesTo: ['normal', 'ca'] } },
  { value: 'supp:skill', label: '与ダメ上昇（アビ）', slot: { kind: 'supp', appliesTo: ['skill'] } },
  { value: 'da', label: 'DA確率', slot: { kind: 'da' } },
  { value: 'ta', label: 'TA確率', slot: { kind: 'ta' } },
  { value: 'echo', label: '追撃', slot: { kind: 'echo' } },
  { value: 'caDmg', label: '奥義ダメUP', slot: { kind: 'caDmg' } },
  { value: 'skillDmg', label: 'アビダメUP', slot: { kind: 'skillDmg' } },
  { value: 'display', label: '表示のみ（計算に使わない）', slot: { kind: 'display' } },
];

function assignValue(slot: SlotSpec | undefined): string {
  if (!slot) return '';
  const hit = ASSIGN_OPTIONS.find((o) => JSON.stringify(o.slot) === JSON.stringify(slot));
  return hit?.value ?? '';
}

const labelDef = (id: string | null): LabelDef | undefined => (id ? labels.labels.find((l) => l.id === id) : undefined);

function describeSlot(slot: SlotSpec): string {
  switch (slot.kind) {
    case 'atk':
      return frames.find((f) => f.id === slot.frame)?.name ?? slot.frame;
    case 'capUp':
      return slot.appliesTo.length === 3 ? '汎用' : slot.appliesTo.map((t) => ({ normal: '通常', ca: '奥義', skill: 'アビ' })[t]).join('・');
    case 'amp':
      return slot.condition === 'vsAdvantage' ? '有利属性のみ' : slot.seraphic ? '天司系' : '';
    case 'supp':
      return slot.appliesTo.includes('skill') ? 'アビ' : '通常・奥義';
    default:
      return '';
  }
}

/** 元画像の該当セルの切り抜き */
function CellCrop({ image, bbox }: { image: HTMLImageElement | null; bbox: PanelSkill['bbox'] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !image || !bbox) return;
    const pad = 4;
    const [x, y, w, h] = bbox;
    const sx = Math.max(0, x - pad);
    const sy = Math.max(0, y - pad);
    const sw = Math.max(1, Math.min(image.naturalWidth - sx, w + pad * 2));
    const sh = Math.max(1, Math.min(image.naturalHeight - sy, h + pad * 2));
    const H = 64;
    c.height = H;
    c.width = Math.max(1, Math.round((sw / sh) * H));
    c.getContext('2d')?.drawImage(image, sx, sy, sw, sh, 0, 0, c.width, H);
  }, [image, bbox]);
  if (!image || !bbox) return <span className="crop empty" aria-hidden="true" />;
  return <canvas ref={ref} className="crop" role="img" aria-label="元画像の該当部分" />;
}

function HeaderConf({ meta }: { meta: FieldMeta | undefined }) {
  return meta ? <ConfBadge value={meta.confidence} /> : null;
}

interface Props {
  panel: PanelValues;
  meta: (CellMeta | null)[];
  header: ParseResult['header'];
  dispatch: Dispatch<Action>;
  image: HTMLImageElement | null;
  hover: number | null;
  setHover: (i: number | null) => void;
}

export function PanelForm({ panel, meta, header, dispatch, image, hover, setHover }: Props) {
  const [copied, setCopied] = useState<number | null>(null);
  const est = panel.estimate;
  const vs = est?.vsElement;
  const setEstimate = (plain: number | null, vsValue: number | null | undefined, vsEl?: Element) => {
    const el = vsEl ?? vs?.element ?? 'earth';
    const v = vsValue === undefined ? vs?.value ?? null : vsValue;
    const next: PanelValues['estimate'] =
      plain === null && v === null ? undefined : { plain: plain ?? 0, ...(v !== null ? { vsElement: { element: el, value: v } } : {}) };
    dispatch({ type: 'patchPanel', patch: { estimate: next } });
  };

  const indexed = panel.skills.map((s, i) => ({ s, i, slot: slotOf(s, labels) }));

  const copyJson = async (s: PanelSkill, i: number) => {
    const slot = s.assign;
    if (!slot) return;
    const entry = {
      id: `custom_${s.labelRaw.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 20) || 'item'}`,
      name: s.labelRaw,
      aliases: [s.labelRaw],
      slot,
      unit: s.unit,
      range: s.unit === '%' ? [0, 1000] : [0, 10_000_000],
      status: 'confirmed',
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(entry, null, 2));
      setCopied(i);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      window.prompt('labels.json に追記する JSON', JSON.stringify(entry));
    }
  };

  return (
    <Panel
      id="panel-b"
      step="B"
      title="確認フォーム"
      actions={
        <button
          type="button"
          className="btn ghost"
          onClick={() => dispatch({ type: 'addSkill', skill: { labelRaw: '', labelId: 'normal_might', value: 0, unit: '%', confidence: 1 } })}
        >
          ＋ 項目を追加
        </button>
      }
    >
      <p className="note">読み取った値を確認し、違っていたら直してください。色と「中」「低」の表示は OCR の信頼度です。</p>

      <h3 className="group-title">ヘッダ</h3>
      <div className="fields">
        <label className="field">
          <span>予測ダメージ</span>
          <NumInput label="予測ダメージ" value={est?.plain} onChange={(v) => setEstimate(v, undefined)} placeholder="847,974" />
          <HeaderConf meta={header.plain} />
        </label>
        <div className="field">
          <span>
            対
            <select
              aria-label="対属性"
              value={vs?.element ?? 'earth'}
              onChange={(e) => setEstimate(est?.plain ?? null, vs?.value ?? null, e.target.value as Element)}
            >
              {ELEMENTS.map((el) => (
                <option key={el} value={el}>
                  {ELEMENT_NAMES[el]}
                </option>
              ))}
            </select>
            属性予測ダメージ
          </span>
          <NumInput label="対属性予測ダメージ" value={vs?.value} onChange={(v) => setEstimate(est?.plain ?? null, v)} placeholder="1,243,337" />
          <HeaderConf meta={header.vs} />
        </div>
        <label className="field">
          <span>最大HP</span>
          <NumInput label="最大HP" value={panel.maxHp} onChange={(v) => dispatch({ type: 'patchPanel', patch: { maxHp: v ?? undefined } })} />
          <HeaderConf meta={header.maxHp} />
        </label>
        <div className="field">
          <span>
            <select
              aria-label="グリッドの属性"
              value={panel.element ?? ''}
              onChange={(e) => dispatch({ type: 'patchPanel', patch: { element: (e.target.value || undefined) as Element | undefined } })}
            >
              <option value="">—</option>
              {ELEMENTS.map((el) => (
                <option key={el} value={el}>
                  {ELEMENT_NAMES[el]}
                </option>
              ))}
            </select>
            属性スキルエンハンス（通常 / M / K %）
          </span>
          <span className="triple">
            {(['normal', 'magna', 'k'] as const).map((k) => (
              <NumInput
                key={k}
                size="s"
                label={`エンハンス ${k === 'normal' ? '通常' : k === 'magna' ? 'M' : 'K'}`}
                value={panel.enhance[k]}
                onChange={(v) => dispatch({ type: 'patchPanel', patch: { enhance: { ...panel.enhance, [k]: v ?? 0 } } })}
              />
            ))}
          </span>
          <HeaderConf meta={header.enhance} />
        </div>
      </div>

      {panel.skills.length === 0 ? (
        <p className="empty">まだ項目がありません。A にスクショを入れるか、「サンプル値」を押してください。</p>
      ) : null}

      {GROUPS.map((g) => {
        const rows = indexed.filter((r) => g.kinds.includes(r.slot.kind));
        if (rows.length === 0) return null;
        return (
          <div key={g.key} className={`skill-group group-${g.key}`}>
            <h3 className="group-title">{g.title}</h3>
            {rows.map(({ s, i, slot }) => {
              const def = labelDef(s.labelId);
              const m = meta[i] ?? null;
              const flags = m?.flags ?? [];
              const unclassified = slot.kind === 'unclassified' || !!s.assign;
              return (
                <div
                  key={i}
                  className={`skill-row conf-row-${s.confidence >= labels.confidenceLevels.high ? 'high' : s.confidence >= labels.confidenceLevels.mid ? 'mid' : 'low'}${s.ignored ? ' ignored' : ''}${hover === i ? ' hover' : ''}`}
                  onPointerEnter={() => setHover(i)}
                  onPointerLeave={() => setHover(null)}
                >
                  <CellCrop image={image} bbox={s.bbox} />
                  <div className="skill-label">
                    <select
                      aria-label="項目"
                      value={s.labelId ?? ''}
                      onChange={(e) => {
                        const id = e.target.value || null;
                        const d = labelDef(id);
                        dispatch({ type: 'updateSkill', index: i, patch: { labelId: id, assign: undefined, ...(d ? { unit: d.unit } : {}) } });
                      }}
                    >
                      <option value="">（未分類）</option>
                      {labels.labels.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                          {l.status === 'assumed' ? '（想定）' : ''}
                        </option>
                      ))}
                    </select>
                    <span className="sub">
                      {s.labelRaw && s.labelRaw !== def?.name ? `読み: ${s.labelRaw}` : ''}
                      {describeSlot(slot) ? ` ${describeSlot(slot)}` : ''}
                    </span>
                  </div>
                  <span className="skill-value">
                    <NumInput label={`${def?.name ?? s.labelRaw} の値`} size="s" value={s.value} onChange={(v) => dispatch({ type: 'updateSkill', index: i, patch: { value: v ?? 0 } })} />
                    <span className="unit">{s.unit === '%' ? '%' : ''}</span>
                  </span>
                  <ConfBadge value={s.confidence} />
                  <label className="use" title="計算に使う">
                    <input
                      type="checkbox"
                      checked={!s.ignored}
                      onChange={(e) => dispatch({ type: 'updateSkill', index: i, patch: { ignored: !e.target.checked } })}
                    />
                    使う
                  </label>
                  <button type="button" className="icon" aria-label="この項目を削除" onClick={() => dispatch({ type: 'removeSkill', index: i })}>
                    ✕
                  </button>
                  {flags.length > 0 ? (
                    <p className="flags">
                      <span aria-hidden="true">⚠</span> 要確認: {flags.map((f) => FLAG_TEXT[f]).join('・')}
                      {m && m.valueRaw ? `（読み「${m.valueRaw}」）` : ''}
                    </p>
                  ) : null}
                  {unclassified ? (
                    <div className="assign">
                      <select
                        aria-label="割り当てる枠"
                        value={assignValue(s.assign)}
                        onChange={(e) => {
                          const opt = ASSIGN_OPTIONS.find((o) => o.value === e.target.value);
                          dispatch({ type: 'updateSkill', index: i, patch: { assign: opt?.slot } });
                        }}
                      >
                        <option value="">枠を割り当てる…</option>
                        {ASSIGN_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                      {s.assign ? (
                        <button type="button" className="btn ghost small" onClick={() => void copyJson(s, i)}>
                          {copied === i ? 'コピーしました' : 'labels.json 用 JSON をコピー'}
                        </button>
                      ) : null}
                      {def?.note ? <span className="sub">{def.note}</span> : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        );
      })}
    </Panel>
  );
}
