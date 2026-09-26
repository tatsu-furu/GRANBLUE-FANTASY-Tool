// Node（テスト）で画像を RGBA に読み書きする
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, resolve } from 'node:path';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import type { RGBAImage } from '../src/ocr/types';

export function loadImage(file: string): RGBAImage {
  const buf = readFileSync(file);
  const ext = extname(file).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') {
    const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
    return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
  }
  const png = PNG.sync.read(buf);
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
}

export function encodePng(img: RGBAImage): Buffer {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  return PNG.sync.write(png);
}

/** npm の @tesseract.js-data/{jpn,eng} を1つのディレクトリにまとめる（tesseract.js は langPath を1つしか取らない） */
export function prepareLangPath(root: string, langs: string[]): string {
  const require = createRequire(import.meta.url);
  const dir = resolve(root, '.tess-cache/lang');
  mkdirSync(dir, { recursive: true });
  for (const lang of langs) {
    const dest = resolve(dir, `${lang}.traineddata.gz`);
    if (existsSync(dest)) continue;
    const pkg = dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`));
    copyFileSync(resolve(pkg, '4.0.0_best_int', `${lang}.traineddata.gz`), dest);
  }
  return dir;
}
