// OCR のゴールデンテスト（npm run test:ocr）。Node 上の tesseract.js で実行するので遅い。
// - fixtures/synthetic/*.png: CSS で描いた模擬パネル（リポジトリに含む）
// - fixtures/panel-001.png: 手元のスクショ（リポジトリには入れない。置いたときだけ実行）
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import expected from '../fixtures/panel-001.json';
import { defaultData } from '../src/engine/data';
import { runOcr, type OcrResult } from '../src/ocr/pipeline';
import { TesseractRecognizer } from '../src/ocr/tesseract';
import { encodePng, loadImage, prepareLangPath } from './node-image';

const root = resolve(__dirname, '..');
const labels = defaultData.labels;
const recognizer = new TesseractRecognizer({
  langPath: prepareLangPath(root, ['jpn', 'eng']),
  cacheMethod: 'none',
  toImage: encodePng,
});

afterAll(async () => {
  await recognizer.terminate();
});

interface Score {
  matched: number;
  total: number;
  misses: string[];
}

/** ラベル・値とも一致した項目数（無視にした重複は数えない） */
function score(result: OcrResult): Score {
  const byName = new Map<string, number>();
  for (const s of result.panel.skills) {
    if (s.ignored || !s.labelId) continue;
    const name = labels.labels.find((l) => l.id === s.labelId)!.name;
    byName.set(name, s.value);
  }
  const misses: string[] = [];
  let matched = 0;
  for (const [name, value] of Object.entries(expected.skills)) {
    const got = byName.get(name);
    if (got !== undefined && Math.abs(got - value) < 1e-9) matched++;
    else misses.push(`${name}: 期待 ${value} / 読み ${got ?? '(なし)'}`);
  }
  return { matched, total: Object.keys(expected.skills).length, misses };
}

const cases = [
  { name: '模擬パネル 1x（520px 幅）', file: 'fixtures/synthetic/panel-synthetic-001@1x.png', strictHeader: true },
  { name: '模擬パネル 2x（1040px 幅）', file: 'fixtures/synthetic/panel-synthetic-001@2x.png', strictHeader: true },
  { name: '手元のスクショ panel-001', file: 'fixtures/panel-001.png', strictHeader: false },
];

describe('OCR ゴールデンテスト（20項目中18項目以上でラベル・値とも一致）', () => {
  for (const c of cases) {
    const path = resolve(root, c.file);
    it.skipIf(!existsSync(path))(c.name, async () => {
      const result = await runOcr(loadImage(path), recognizer, labels);
      const s = score(result);
      console.log(
        `[${c.name}] ${s.matched}/${s.total} 一致 | 採用: ${result.variant} | 見出し: ${result.headingFound ? 'あり' : 'なし'} | ${result.durationMs}ms`,
      );
      if (s.misses.length > 0) console.log(`  不一致: ${s.misses.join(' / ')}`);
      if (result.unmatched.length > 0) console.log(`  読めたが組にならなかった: ${result.unmatched.map((u) => u.text).join(' / ')}`);
      console.log(`  ヘッダ: ${JSON.stringify({ estimate: result.panel.estimate, maxHp: result.panel.maxHp, element: result.panel.element, enhance: result.panel.enhance })}`);
      expect(s.matched).toBeGreaterThanOrEqual(18);
      if (c.strictHeader) {
        expect(result.panel.estimate).toEqual(expected.estimate);
        expect(result.panel.maxHp).toBe(expected.maxHp);
        expect(result.panel.element).toBe(expected.element);
        expect(result.panel.enhance).toEqual(expected.enhance);
      }
    });
  }
});
