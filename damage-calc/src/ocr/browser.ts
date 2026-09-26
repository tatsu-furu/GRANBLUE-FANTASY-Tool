// ブラウザ専用: 画像の読み込みと tesseract.js の Worker（画面を開いている間は使い回す）
import { TesseractRecognizer } from './tesseract';
import type { OcrResult } from './pipeline';
import type { Rect, RGBAImage } from './types';

export async function loadImage(blob: Blob): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = URL.createObjectURL(blob);
  await img.decode();
  return img;
}

export function imageToRGBA(img: HTMLImageElement): RGBAImage {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('canvas が使えません');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: d.width, height: d.height, data: d.data };
}

export function rgbaToCanvas(img: RGBAImage): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  canvas.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return canvas;
}

let recognizer: TesseractRecognizer | null = null;
let loadListener: ((status: string, progress: number) => void) | null = null;

/**
 * 認識器は1つ作って使い回す。VITE_TESS_BASE を指定してビルドすると worker・core・言語データを
 * その場所から読む（未指定なら tesseract.js の既定の CDN。スクショ自体はどこにも送らない）。
 */
export function getRecognizer(onLoad: (status: string, progress: number) => void): TesseractRecognizer {
  loadListener = onLoad;
  if (!recognizer) {
    const env = import.meta.env.VITE_TESS_BASE;
    // core・言語データは Worker の中から読むので、ページ基準の相対パスは絶対 URL にしておく
    const base = env ? new URL(env, document.baseURI).href.replace(/\/$/, '') : undefined;
    recognizer = new TesseractRecognizer({
      toImage: rgbaToCanvas,
      onLoadProgress: (status, progress) => loadListener?.(status, progress),
      ...(base ? { workerPath: `${base}/worker.min.js`, corePath: `${base}/core`, langPath: `${base}/lang` } : {}),
    });
  }
  return recognizer;
}

const LOAD_MESSAGES: Record<string, string> = {
  'loading tesseract core': '文字認識エンジンを読み込んでいます',
  'initializing tesseract': '文字認識エンジンを準備しています',
  'loading language traineddata': '言語データを読み込んでいます（初回のみ数MB）',
  'initializing api': '文字認識エンジンを準備しています',
};

export function loadMessage(status: string): string {
  return LOAD_MESSAGES[status] ?? '文字認識エンジンを準備しています';
}

/** 切り抜いた範囲で認識した結果の座標を、元画像の座標に戻す */
export function offsetResult(r: OcrResult, dx: number, dy: number): OcrResult {
  const move = (b: Rect): Rect => ({ ...b, x: b.x + dx, y: b.y + dy });
  return {
    ...r,
    panel: {
      ...r.panel,
      skills: r.panel.skills.map((s) => (s.bbox ? { ...s, bbox: [s.bbox[0] + dx, s.bbox[1] + dy, s.bbox[2], s.bbox[3]] } : s)),
    },
    meta: r.meta.map((m) => ({
      ...m,
      ...(m.labelBBox ? { labelBBox: move(m.labelBBox) } : {}),
      ...(m.valueBBox ? { valueBBox: move(m.valueBBox) } : {}),
    })),
    header: Object.fromEntries(
      Object.entries(r.header).map(([k, f]) => [k, f && f.bbox ? { ...f, bbox: move(f.bbox) } : f]),
    ) as OcrResult['header'],
    unmatched: r.unmatched.map((u) => (u.bbox ? { ...u, bbox: move(u.bbox) } : u)),
    words: r.words.map((w) => ({ ...w, bbox: move(w.bbox) })),
    splitX: r.splitX === null ? null : r.splitX + dx,
  };
}
