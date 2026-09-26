// スクショ → パネル値。前処理2種類で認識して信頼度の合計が高い方を採用し、値の領域だけ数字限定で読み直す。
import type { LabelData } from '../engine/types';
import { findHeadingIndex, gridSplitX, groupLines, splitCells } from './layout';
import { interpretPairs, pairLines, parseValue, unionRect, type Pair, type ParseResult, type Seg, type Token } from './parse';
import { cropImage, preprocess, type VariantName } from './preprocess';
import type { OcrWord, Recognizer, Rect, RGBAImage } from './types';

export interface OcrStage {
  stage: 'preprocess' | 'recognize' | 'digits' | 'parse' | 'done';
  progress: number; // 0..1（全体）
  message: string;
}

export interface OcrResult extends ParseResult {
  scale: number;
  variant: VariantName;
  scores: Record<VariantName, number>;
  words: OcrWord[]; // 元画像の座標
  headingFound: boolean;
  splitX: number | null; // 元画像の座標
  durationMs: number;
}

export interface OcrOptions {
  variants?: VariantName[];
  digitPass?: boolean;
  debug?: (message: string) => void;
}

const VARIANT_LABEL: Record<VariantName, string> = { binary: '二値化あり', gray: '二値化なし' };

const scaleRect = (r: Rect, k: number): Rect => ({ x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k });

export async function runOcr(
  img: RGBAImage,
  recognizer: Recognizer,
  labels: LabelData,
  onStage: (s: OcrStage) => void = () => {},
  opts: OcrOptions = {},
): Promise<OcrResult> {
  const started = Date.now();
  const variantNames = opts.variants ?? ['binary', 'gray'];
  onStage({ stage: 'preprocess', progress: 0.02, message: '画像を前処理しています' });
  const pre = preprocess(img);

  // 1. 前処理2種類で全体を認識し、単語の信頼度の合計が高い方を採用
  const recognized = {} as Record<VariantName, OcrWord[]>;
  const scores = { binary: 0, gray: 0 } as Record<VariantName, number>;
  const span = 0.8 / variantNames.length;
  for (const [i, name] of variantNames.entries()) {
    const base = 0.05 + i * span;
    onStage({ stage: 'recognize', progress: base, message: `文字を認識しています（${VARIANT_LABEL[name]}）` });
    const words = await recognizer.recognizeWords(pre.variants[name], (p) =>
      onStage({ stage: 'recognize', progress: base + span * p, message: `文字を認識しています（${VARIANT_LABEL[name]}）` }),
    );
    recognized[name] = words;
    scores[name] = words.reduce((s, w) => s + (w.text.trim() ? w.confidence : 0), 0);
  }
  const variant = variantNames.reduce((a, b) => (scores[b] > scores[a] ? b : a));
  const words = recognized[variant];

  // 2. 行にまとめ、見出しより下は左右のセルに分ける
  const lines = groupLines(words);
  const heading = findHeadingIndex(lines, labels);
  const grid = heading >= 0 ? lines.slice(heading + 1) : [];
  const splitX = gridSplitX(grid);
  const gridWords = grid.flat();
  const gridLeft = Math.min(...gridWords.map((w) => w.bbox.x));
  const gridRight = Math.max(...gridWords.map((w) => w.bbox.x + w.bbox.w));
  const toTokens = (ws: OcrWord[]): Token[] => ws.map((w) => ({ text: w.text, bbox: w.bbox, conf: w.confidence }));
  // グリッドのセルは右端（値を探す範囲）も持っておく
  const cellLines: { tokens: Token[]; right: number | null }[] = [];
  lines.forEach((line, i) => {
    if (heading >= 0 && i > heading && splitX !== null) {
      const [left, right] = splitCells(line, splitX);
      if (left.length > 0) cellLines.push({ tokens: toTokens(left), right: splitX });
      if (right.length > 0) cellLines.push({ tokens: toTokens(right), right: gridRight });
    } else {
      cellLines.push({ tokens: toTokens(line), right: null });
    }
  });
  const digitPass = opts.digitPass !== false;
  const pairs: Pair[] = [];
  const recovered = new Set<Seg>(); // 数字限定で読み直して得た値（3b では読み直さない）
  for (const cl of cellLines) {
    for (const p of pairLines([cl.tokens], { carryOver: false })) {
      // 3a. グリッドのセルで値が読めなかったら、ラベルの右側だけ数字限定で読み直す（「5%」のような短い値の取りこぼし対策）
      const lb = p.labelSegs.reduce<Rect | undefined>((acc, s) => (s.bbox ? (acc ? unionRect(acc, s.bbox) : s.bbox) : acc), undefined);
      if (digitPass && !p.value && cl.right !== null && lb && Number.isFinite(gridLeft)) {
        const x = lb.x + lb.w + lb.h * 0.3;
        const region: Rect = { x, y: lb.y - lb.h * 0.25, w: cl.right - x, h: lb.h * 1.5 };
        if (region.w > lb.h) {
          const r = await recognizer.recognizeValue(cropImage(pre.variants[variant], region, 2));
          const text = r.text.replace(/\s+/g, '');
          opts.debug?.(
            `recover "${p.labelSegs.map((s) => s.text).join('')}" label=${JSON.stringify(lb)} region=${JSON.stringify(region)} → "${text}" (${r.confidence.toFixed(0)})`,
          );
          if (parseValue(text)) {
            const seg: Seg = { text, numeric: true, bbox: region, conf: r.confidence };
            recovered.add(seg);
            p.value = seg;
          }
        }
      }
      pairs.push(p);
    }
  }

  // 3b. 値の領域だけ切り出して 0-9 . , % + - に限定して読み直し、元より信頼度が高いか元が数値として読めないときだけ置き換える
  if (digitPass) {
    const valueSegs = pairs
      .flatMap((p) => [p.value, ...p.extra])
      .filter((s): s is Seg => s !== null && s.bbox !== undefined && !recovered.has(s));
    for (const [i, seg] of valueSegs.entries()) {
      onStage({ stage: 'digits', progress: 0.85 + (0.12 * i) / valueSegs.length, message: `数値を読み直しています（${i + 1}/${valueSegs.length}）` });
      const crop = cropImage(pre.variants[variant], seg.bbox!, Math.max(4, seg.bbox!.h * 0.3));
      const r = await recognizer.recognizeValue(crop);
      const text = r.text.replace(/\s+/g, '');
      // 元も数値として読めていて読みが違うときは、はっきり信頼度が高いときだけ置き換える
      const orig = parseValue(seg.text);
      const better =
        parseValue(text) !== null &&
        (orig === null || (text === seg.text ? r.confidence > (seg.conf ?? 100) : r.confidence >= (seg.conf ?? 100) + 5));
      opts.debug?.(`digits "${seg.text}" (${(seg.conf ?? 100).toFixed(0)}) → "${text}" (${r.confidence.toFixed(0)})${better ? ' 採用' : ''}`);
      if (better) {
        seg.text = text;
        seg.conf = r.confidence;
      }
    }
  }

  onStage({ stage: 'parse', progress: 0.98, message: '項目を照合しています' });
  const parsed = interpretPairs(pairs, labels);

  // 4. 座標を元画像に戻す
  const k = 1 / pre.scale;
  for (const s of parsed.panel.skills) {
    if (s.bbox) {
      const r = scaleRect({ x: s.bbox[0], y: s.bbox[1], w: s.bbox[2], h: s.bbox[3] }, k);
      s.bbox = [r.x, r.y, r.w, r.h];
    }
  }
  for (const m of parsed.meta) {
    if (m.labelBBox) m.labelBBox = scaleRect(m.labelBBox, k);
    if (m.valueBBox) m.valueBBox = scaleRect(m.valueBBox, k);
  }
  for (const f of Object.values(parsed.header)) if (f?.bbox) f.bbox = scaleRect(f.bbox, k);
  for (const u of parsed.unmatched) if (u.bbox) u.bbox = scaleRect(u.bbox, k);

  onStage({ stage: 'done', progress: 1, message: '完了' });
  return {
    ...parsed,
    scale: pre.scale,
    variant,
    scores,
    words: words.map((w) => ({ ...w, bbox: scaleRect(w.bbox, k) })),
    headingFound: heading >= 0,
    splitX: splitX === null ? null : splitX * k,
    durationMs: Date.now() - started,
  };
}
