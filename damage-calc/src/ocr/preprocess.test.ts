import { describe, expect, it } from 'vitest';
import { defaultData } from '../engine/data';
import { findHeadingIndex, gridSplitX, groupLines, splitCells } from './layout';
import { binarize, cropImage, grayMax, invert, otsuThreshold, preprocess, resizeBilinear, scaleFactorFor } from './preprocess';
import type { OcrWord, RGBAImage } from './types';

const solid = (w: number, h: number, rgba: [number, number, number, number]): RGBAImage => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(rgba, i * 4);
  return { width: w, height: h, data };
};

describe('前処理', () => {
  it('短辺が 1200px 前後になるよう 1〜3 倍に拡大する', () => {
    expect(scaleFactorFor(400, 700)).toBe(3);
    expect(scaleFactorFor(600, 900)).toBe(2);
    expect(scaleFactorFor(1170, 2532)).toBeCloseTo(1200 / 1170, 12);
    expect(scaleFactorFor(2000, 3000)).toBe(1);
  });
  it('バイリニア拡大で大きさが変わり、単色は単色のまま', () => {
    const r = resizeBilinear(solid(10, 5, [10, 20, 30, 255]), 2.5);
    expect([r.width, r.height]).toEqual([25, 13]);
    expect(Array.from(r.data.slice(0, 4))).toEqual([10, 20, 30, 255]);
  });
  it('グレースケールは max(R,G,B)（緑やオレンジの文字も明るく残る）', () => {
    const img: RGBAImage = { width: 3, height: 1, data: new Uint8ClampedArray([40, 220, 60, 255, 250, 150, 20, 255, 30, 30, 40, 255]) };
    expect(Array.from(grayMax(img))).toEqual([220, 250, 40]);
  });
  it('大津の閾値は2つの山の間に来る', () => {
    const gray = new Uint8ClampedArray([...Array(50).fill(30), ...Array(50).fill(220)]);
    const t = otsuThreshold(gray);
    expect(t).toBeGreaterThanOrEqual(30);
    expect(t).toBeLessThan(220);
    expect(Array.from(binarize(gray, t).slice(48, 52))).toEqual([0, 0, 255, 255]);
  });
  it('暗い背景に明るい文字 → 反転して白地に黒文字', () => {
    expect(Array.from(invert(new Uint8ClampedArray([0, 255, 200])))).toEqual([255, 0, 55]);
    const pre = preprocess(solid(400, 600, [20, 20, 30, 255]));
    expect(pre.scale).toBe(3);
    expect(pre.variants.gray.data[0]).toBe(255 - 30);
  });
  it('切り抜きは画像の外にはみ出さない', () => {
    const c = cropImage(solid(10, 10, [1, 2, 3, 255]), { x: 8, y: 8, w: 5, h: 5 }, 1);
    expect([c.width, c.height]).toEqual([3, 3]);
  });
});

const word = (text: string, x: number, y: number, w = 40, h = 20): OcrWord => ({ text, confidence: 90, bbox: { x, y, w, h } });

describe('行まとめと2列分割', () => {
  const words = [
    word('M攻刃', 320, 102),
    word('攻刃', 10, 100),
    word('54%', 200, 101),
    word('296%', 520, 99),
    word('発動中の武器スキル', 10, 60, 200),
    word('予測ダメージ', 10, 20, 120),
    word('847,974', 480, 22, 80),
  ];
  const lines = groupLines(words);
  it('y が近い単語を同じ行にまとめ、行内は x の昇順', () => {
    expect(lines.map((l) => l.map((w) => w.text))).toEqual([['予測ダメージ', '847,974'], ['発動中の武器スキル'], ['攻刃', '54%', 'M攻刃', '296%']]);
  });
  it('見出しの行を見つけ、グリッド行を左右のセルに分ける', () => {
    expect(findHeadingIndex(lines, defaultData.labels)).toBe(1);
    const x = gridSplitX(lines.slice(2))!;
    expect(x).toBeCloseTo((10 + 560) / 2, 9);
    const [left, right] = splitCells(lines[2]!, x);
    expect(left.map((w) => w.text)).toEqual(['攻刃', '54%']);
    expect(right.map((w) => w.text)).toEqual(['M攻刃', '296%']);
  });
});
