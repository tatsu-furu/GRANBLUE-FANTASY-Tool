// 模擬パネル（scripts/synthetic-panel.html）を Chromium で描いて fixtures/synthetic/ に PNG を書き出す。
// 使い方: npm run fixtures:synthetic
//   CHROMIUM_PATH でブラウザの実行ファイルを指定できる（未指定なら /opt/pw-browsers/chromium、無ければ Chrome を使う）
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = resolve(root, 'scripts/synthetic-panel.html');
const outDir = resolve(root, 'fixtures/synthetic');
mkdirSync(outDir, { recursive: true });

const executablePath = process.env.CHROMIUM_PATH ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch(executablePath ? { executablePath } : { channel: 'chrome' });
try {
  for (const scale of [1, 2]) {
    const page = await browser.newPage({ deviceScaleFactor: scale, viewport: { width: 600, height: 900 } });
    await page.goto(pathToFileURL(html).href);
    const out = resolve(outDir, `panel-synthetic-001@${scale}x.png`);
    await page.locator('#panel').screenshot({ path: out });
    console.log('wrote', out);
    await page.close();
  }
} finally {
  await browser.close();
}
