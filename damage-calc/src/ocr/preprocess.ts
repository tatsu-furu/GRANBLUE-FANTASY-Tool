// 画像の前処理。ブラウザと Node で同じ結果になるよう、canvas に頼らず RGBA 配列で処理する。
import type { Rect, RGBAImage } from './types';

/** 短辺が target px 前後になる拡大率（1〜3倍） */
export function scaleFactorFor(width: number, height: number, target = 1200): number {
  return Math.min(3, Math.max(1, target / Math.min(width, height)));
}

export function resizeBilinear(img: RGBAImage, factor: number): RGBAImage {
  if (factor === 1) return img;
  const { width: w, height: h, data } = img;
  const W = Math.max(1, Math.round(w * factor));
  const H = Math.max(1, Math.round(h * factor));
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(h - 1, Math.max(0, (y + 0.5) / factor - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(h - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < W; x++) {
      const sx = Math.min(w - 1, Math.max(0, (x + 0.5) / factor - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(w - 1, x0 + 1);
      const fx = sx - x0;
      const i00 = (y0 * w + x0) * 4;
      const i01 = (y0 * w + x1) * 4;
      const i10 = (y1 * w + x0) * 4;
      const i11 = (y1 * w + x1) * 4;
      const o = (y * W + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = data[i00 + c]! * (1 - fx) + data[i01 + c]! * fx;
        const bottom = data[i10 + c]! * (1 - fx) + data[i11 + c]! * fx;
        out[o + c] = top * (1 - fy) + bottom * fy;
      }
    }
  }
  return { width: W, height: H, data: out };
}

/** 各画素の max(R, G, B)。緑の予測ダメージやオレンジの D上限 も白文字と同じく明るく残る */
export function grayMax(img: RGBAImage): Uint8ClampedArray {
  const n = img.width * img.height;
  const g = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    g[i] = Math.max(img.data[o]!, img.data[o + 1]!, img.data[o + 2]!);
  }
  return g;
}

export function invert(gray: Uint8ClampedArray): Uint8ClampedArray {
  return gray.map((v) => 255 - v);
}

/** 大津の二値化の閾値 */
export function otsuThreshold(gray: Uint8ClampedArray): number {
  const hist = new Array<number>(256).fill(0);
  for (const v of gray) hist[v]!++;
  const total = gray.length;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t]!;
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > bestVar) {
      bestVar = between;
      best = t;
    }
  }
  return best;
}

export function binarize(gray: Uint8ClampedArray, threshold: number): Uint8ClampedArray {
  return gray.map((v) => (v <= threshold ? 0 : 255));
}

export function grayToRGBA(gray: Uint8ClampedArray, width: number, height: number): RGBAImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < gray.length; i++) {
    const o = i * 4;
    data[o] = data[o + 1] = data[o + 2] = gray[i]!;
    data[o + 3] = 255;
  }
  return { width, height, data };
}

export function cropImage(img: RGBAImage, rect: Rect, pad = 0): RGBAImage {
  const x0 = Math.max(0, Math.floor(rect.x - pad));
  const y0 = Math.max(0, Math.floor(rect.y - pad));
  const x1 = Math.min(img.width, Math.ceil(rect.x + rect.w + pad));
  const y1 = Math.min(img.height, Math.ceil(rect.y + rect.h + pad));
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = ((y0 + y) * img.width + x0) * 4;
    data.set(img.data.subarray(src, src + w * 4), y * w * 4);
  }
  return { width: w, height: h, data };
}

export type VariantName = 'binary' | 'gray';

export interface Preprocessed {
  scale: number;
  variants: Record<VariantName, RGBAImage>;
}

/** 拡大 → max(R,G,B) → 反転（暗い背景を白に）→ 二値化あり / なし の2種類 */
export function preprocess(img: RGBAImage): Preprocessed {
  const scale = scaleFactorFor(img.width, img.height);
  const scaled = resizeBilinear(img, scale);
  const inv = invert(grayMax(scaled));
  const bin = binarize(inv, otsuThreshold(inv));
  return {
    scale,
    variants: {
      binary: grayToRGBA(bin, scaled.width, scaled.height),
      gray: grayToRGBA(inv, scaled.width, scaled.height),
    },
  };
}
