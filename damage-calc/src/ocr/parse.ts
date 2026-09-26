// パネルのテキスト（OCR の単語列、または貼り付けたテキスト）から項目と値を取り出す。
import type { Element, LabelData, PanelSkill, PanelValues } from '../engine/types';
import { assignLabels, matchHeader, rankLabels } from './match';
import { normalizeText, type WChar } from './normalize';
import type { Rect } from './types';

export interface Token {
  text: string;
  bbox?: Rect;
  conf?: number; // 0..100
}

export interface Seg {
  text: string;
  numeric: boolean;
  bbox?: Rect;
  conf?: number;
}

export interface Pair {
  labelSegs: Seg[];
  value: Seg | null;
  extra: Seg[]; // ラベルなしで続いた値（エンハンスの M・K など）
}

export type CellFlag = 'unit' | 'range' | 'value' | 'duplicate' | 'ambiguous';

export interface CellMeta {
  labelRaw: string;
  valueRaw: string;
  labelBBox?: Rect;
  valueBBox?: Rect;
  ocrConfidence: number; // 0..1
  matchScore: number; // 0..1
  bestGuessId: string; // 未分類でも最も近かった辞書項目
  flags: CellFlag[];
}

export interface FieldMeta {
  raw: string;
  bbox?: Rect;
  confidence: number;
}

export interface ParseResult {
  panel: PanelValues;
  meta: CellMeta[]; // panel.skills と同じ順番
  header: { plain?: FieldMeta; vs?: FieldMeta; maxHp?: FieldMeta; enhance?: FieldMeta };
  unmatched: { text: string; bbox?: Rect }[];
}

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';

/** 値の文字列を符号・数値・単位に分ける。O→0、l/I/|→1 のよくある誤認識は直す */
export function parseValue(raw: string): { value: number; unit: '%' | 'flat' } | null {
  const s = normalizeText(raw)
    .replace(/,/g, '')
    .replace(/[Oo]/g, '0')
    .replace(/[lI|]/g, '1');
  const m = /^([+-]?)(\d+(?:\.\d+)?)(%?)$/.exec(s);
  if (!m) return null;
  const v = Number(m[2]) * (m[1] === '-' ? -1 : 1);
  return { value: v === 0 ? 0 : v, unit: m[3] === '%' ? '%' : 'flat' };
}

/** 1単語をラベル部分と数値部分に切り分ける（「攻刃54%」のようにくっついて読めた場合）。矩形は文字数の比で分ける */
export function segmentsOf(token: Token): Seg[] {
  const chars = [...normalizeText(token.text)];
  const startsNumber = (i: number) =>
    isDigit(chars[i]) || ((chars[i] === '+' || chars[i] === '-') && isDigit(chars[i + 1]));
  const spans: { start: number; end: number; numeric: boolean }[] = [];
  let i = 0;
  while (i < chars.length) {
    let j = i + 1;
    if (startsNumber(i)) {
      while (j < chars.length && (isDigit(chars[j]) || chars[j] === '.' || chars[j] === ',')) j++;
      if (chars[j] === '%') j++;
      spans.push({ start: i, end: j, numeric: true });
    } else {
      while (j < chars.length && !startsNumber(j)) j++;
      spans.push({ start: i, end: j, numeric: false });
    }
    i = j;
  }
  const total = chars.length;
  return spans.map(({ start, end, numeric }) => {
    const seg: Seg = { text: chars.slice(start, end).join(''), numeric };
    if (token.conf !== undefined) seg.conf = token.conf;
    if (token.bbox) {
      const b = token.bbox;
      seg.bbox = spans.length === 1 ? b : { x: b.x + (b.w * start) / total, y: b.y, w: (b.w * (end - start)) / total, h: b.h };
    }
    return seg;
  });
}

export function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

function joinSegs(a: Seg, b: Seg, text: string): Seg {
  const out: Seg = { text, numeric: true, conf: Math.min(a.conf ?? 100, b.conf ?? 100) };
  if (a.bbox && b.bbox) out.bbox = unionRect(a.bbox, b.bbox);
  else if (a.bbox ?? b.bbox) out.bbox = (a.bbox ?? b.bbox)!;
  return out;
}

/**
 * 分かれて読めた断片をつなぐ:
 * 「847,」「974」→ 847,974 / 「54」「%」→ 54% / 「+」「50000」→ +50000
 */
function mergeFragments(segs: Seg[]): Seg[] {
  const out: Seg[] = [];
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k]!;
    const prev = out[out.length - 1];
    const next = segs[k + 1];
    if (s.numeric && prev?.numeric && !prev.text.endsWith('%') && (/[.,]$/.test(prev.text) || /^[.,]/.test(s.text))) {
      out[out.length - 1] = joinSegs(prev, s, prev.text + s.text);
      continue;
    }
    if (!s.numeric && (s.text === ',' || s.text === '.') && prev?.numeric && next?.numeric && !prev.text.endsWith('%')) {
      out[out.length - 1] = joinSegs(prev, next, prev.text + s.text + next.text);
      k++;
      continue;
    }
    if (!s.numeric && s.text === '%' && prev?.numeric && !prev.text.endsWith('%')) {
      out[out.length - 1] = joinSegs(prev, s, `${prev.text}%`);
      continue;
    }
    if (!s.numeric && /[+-]$/.test(s.text) && next?.numeric && isDigit(next.text[0])) {
      const rest = s.text.slice(0, -1);
      if (rest) out.push({ ...s, text: rest });
      segs[k + 1] = { ...next, text: `${s.text.slice(-1)}${next.text}` };
      continue;
    }
    out.push(s);
  }
  return out;
}

const hasLetter = (s: string) => /[\p{L}\p{N}]/u.test(s);

/**
 * 行ごとに「ラベル → 値」の組を作る。carryOver が true なら、値の無いラベルで終わった行は
 * 次の行が数値で始まるときに持ち越す（縦に並んだテキスト用）。
 */
export function pairLines(lines: Token[][], opts: { carryOver: boolean }): Pair[] {
  const segLines = lines.map((line) => mergeFragments(line.flatMap(segmentsOf)));
  const pairs: Pair[] = [];
  let carry: Seg[] = [];
  segLines.forEach((segs, li) => {
    let pending: Seg[] = carry;
    carry = [];
    let last: Pair | null = null;
    for (const s of segs) {
      if (s.numeric) {
        if (pending.length > 0) {
          last = { labelSegs: pending, value: s, extra: [] };
          pairs.push(last);
          pending = [];
        } else if (last) {
          last.extra.push(s);
        } else {
          last = { labelSegs: [], value: s, extra: [] };
          pairs.push(last);
        }
      } else if (hasLetter(s.text)) {
        pending.push(s);
      }
    }
    if (pending.length > 0) {
      const nextFirst = segLines[li + 1]?.[0];
      if (opts.carryOver && nextFirst?.numeric) carry = pending;
      else pairs.push({ labelSegs: pending, value: null, extra: [] });
    }
  });
  return pairs;
}

function unionOf(segs: Seg[]): Rect | undefined {
  return segs.reduce<Rect | undefined>((acc, s) => (s.bbox ? (acc ? unionRect(acc, s.bbox) : s.bbox) : acc), undefined);
}

const minConf = (segs: Seg[]) => segs.reduce((m, s) => Math.min(m, s.conf ?? 100), 100) / 100;

const LABEL_CHAR = /[\p{L}\p{N}()]/u;

/** 記号を落としたラベルの文字（OCR の信頼度つき） */
function labelChars(segs: Seg[]): WChar[] {
  return segs.flatMap((s) => [...normalizeText(s.text)].filter((ch) => LABEL_CHAR.test(ch)).map((ch) => ({ ch, conf: s.conf ?? 100 })));
}

function elementFromText(text: string, labels: LabelData): Element | undefined {
  const entries = Object.entries(labels.header.elements) as [Element, string][];
  const idx = text.indexOf('属性');
  if (idx > 0) {
    const ch = [...text.slice(0, idx)].pop();
    const hit = entries.find(([, c]) => c === ch);
    if (hit) return hit[0];
  }
  return entries.find(([, c]) => text.includes(c))?.[0];
}

interface SkillCell {
  pair: Pair & { value: Seg };
  label: string;
  chars: WChar[];
  parsed: { value: number; unit: '%' | 'flat' } | null;
}

/** 組の列をパネル値に解釈する */
export function interpretPairs(pairs: Pair[], labels: LabelData): ParseResult {
  const panel: PanelValues = { enhance: { normal: 0, magna: 0, k: 0 }, skills: [] };
  const header: ParseResult['header'] = {};
  const unmatched: ParseResult['unmatched'] = [];
  const cells: SkillCell[] = [];
  let enhanceVals: number[] = [];
  let enhanceNeed = 0;
  const commitEnhance = () => {
    panel.enhance = { normal: enhanceVals[0] ?? 0, magna: enhanceVals[1] ?? 0, k: enhanceVals[2] ?? 0 };
  };

  for (const p of pairs) {
    const chars = labelChars(p.labelSegs);
    const label = chars.map((c) => c.ch).join('');
    const values = [p.value, ...p.extra].filter((v): v is Seg => v !== null);
    const allSegs = [...p.labelSegs, ...values];
    const headerKey = label ? matchHeader(label, labels) : null;

    if (headerKey) {
      enhanceNeed = 0;
      if (headerKey === 'gridHeading') continue;
      const field: FieldMeta = { raw: `${label} ${values.map((v) => v.text).join(' ')}`.trim(), confidence: minConf(allSegs) };
      const bbox = unionOf(allSegs);
      if (bbox) field.bbox = bbox;
      if (headerKey === 'enhance') {
        const el = elementFromText(label, labels);
        if (el) panel.element = el;
        enhanceVals = values
          .map((v) => parseValue(v.text))
          .filter((v) => v !== null)
          .map((v) => v.value)
          .slice(0, 3);
        enhanceNeed = 3 - enhanceVals.length;
        commitEnhance();
        header.enhance = field;
        continue;
      }
      const v = p.value ? parseValue(p.value.text) : null;
      if (!v) {
        unmatched.push({ text: field.raw, ...(bbox ? { bbox } : {}) });
        continue;
      }
      if (headerKey === 'estimatePlain') {
        panel.estimate = { ...panel.estimate, plain: v.value };
        header.plain = field;
      } else if (headerKey === 'estimateVs') {
        const el = elementFromText(label, labels);
        panel.estimate = { plain: panel.estimate?.plain ?? 0, ...(el ? { vsElement: { element: el, value: v.value } } : {}) };
        header.vs = field;
      } else {
        panel.maxHp = v.value;
        header.maxHp = field;
      }
      continue;
    }

    // エンハンスの「通常 20% M 280% K 0%」のような短いラベル付きの値
    if (enhanceNeed > 0 && chars.length <= 3 && values.length > 0) {
      for (const v of values) {
        const pv = parseValue(v.text);
        if (pv && enhanceNeed > 0) {
          enhanceVals.push(pv.value);
          enhanceNeed--;
        }
      }
      commitEnhance();
      continue;
    }
    enhanceNeed = 0;

    if (!p.value || !label) {
      const text = label || values.map((v) => v.text).join(' ');
      const bbox = unionOf(allSegs);
      if (text) unmatched.push({ text, ...(bbox ? { bbox } : {}) });
      continue;
    }
    cells.push({ pair: p as SkillCell['pair'], label, chars, parsed: parseValue(p.value.text) });
  }

  // 辞書照合はパネル全体でまとめて行い、値の妥当性と「同じ項目は1回」を手がかりに曖昧さを解く
  const matches = assignLabels(
    cells.map((c) => rankLabels(c.chars, c.parsed, labels)),
    labels.matchThreshold,
  );

  const meta: CellMeta[] = [];
  cells.forEach((c, i) => {
    const m = matches[i]!;
    const def = m.id ? labels.labels.find((l) => l.id === m.id) : undefined;
    const pv = c.parsed;
    const flags: CellFlag[] = [];
    if (!pv) flags.push('value');
    if (def && pv && pv.unit !== def.unit) flags.push('unit');
    if (def && pv && (pv.value < def.range[0] || pv.value > def.range[1])) flags.push('range');
    if (m.ambiguous) flags.push('ambiguous');
    const ocrConfidence = minConf([...c.pair.labelSegs, c.pair.value]);
    const skill: PanelSkill = {
      labelRaw: c.label,
      labelId: m.id,
      value: pv?.value ?? 0,
      unit: pv?.unit ?? def?.unit ?? '%',
      confidence: Math.min(ocrConfidence, m.score),
    };
    const bbox = unionOf([...c.pair.labelSegs, c.pair.value]);
    if (bbox) skill.bbox = [bbox.x, bbox.y, bbox.w, bbox.h];
    const cell: CellMeta = {
      labelRaw: c.label,
      valueRaw: c.pair.value.text,
      ocrConfidence,
      matchScore: m.score,
      bestGuessId: m.bestId,
      flags,
    };
    const labelBBox = unionOf(c.pair.labelSegs);
    if (labelBBox) cell.labelBBox = labelBBox;
    if (c.pair.value.bbox) cell.valueBBox = c.pair.value.bbox;
    panel.skills.push(skill);
    meta.push(cell);
  });

  // 同じ項目が2回読めたら信頼度の高い方を採用し、低い方は無視にして両方残す
  const groups = new Map<string, number[]>();
  panel.skills.forEach((s, i) => {
    if (s.labelId) groups.set(s.labelId, [...(groups.get(s.labelId) ?? []), i]);
  });
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    const best = idxs.reduce((a, b) => (panel.skills[b]!.confidence > panel.skills[a]!.confidence ? b : a));
    for (const i of idxs) {
      meta[i]!.flags.push('duplicate');
      if (i !== best) panel.skills[i] = { ...panel.skills[i]!, ignored: true };
    }
  }

  return { panel, meta, header, unmatched };
}

/** テキスト貼り付け（スマホ OS の文字認識でコピーした文字列など）。画像 OCR と同じパーサに通す */
export function parseText(text: string, labels: LabelData): ParseResult {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.split(/\s+/).filter(Boolean).map((t): Token => ({ text: t })))
    .filter((l) => l.length > 0);
  return interpretPairs(pairLines(lines, { carryOver: true }), labels);
}
