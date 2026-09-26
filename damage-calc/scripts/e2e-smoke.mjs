// 画面の通し確認（手元用）。開発サーバを起動してから実行する:
//   node scripts/copy-tesseract-local.mjs
//   VITE_TESS_BASE=./tesseract-local npx vite --port 5173
//   node scripts/e2e-smoke.mjs [URL] [出力先]
// スクショを出力先（既定 .e2e-out/）に保存し、コンソールのエラーがあれば終了コード 1。
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const url = process.argv[2] ?? 'http://localhost:5173/';
const out = resolve(process.argv[3] ?? resolve(root, '.e2e-out'));
mkdirSync(out, { recursive: true });
const fixture = resolve(root, 'fixtures/synthetic/panel-synthetic-001@1x.png');

const executablePath = process.env.CHROMIUM_PATH ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch(executablePath ? { executablePath } : { channel: 'chrome' });
const errors = [];
const check = (cond, msg) => {
  if (!cond) {
    errors.push(`確認失敗: ${msg}`);
    console.log('  ✗', msg);
  } else console.log('  ✓', msg);
};

async function newPage(viewport, colorScheme = 'dark') {
  const ctx = await browser.newContext({ viewport, colorScheme, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`HTTP ${r.status()}: ${r.url()}`);
  });
  await page.goto(url);
  return page;
}

const waitOcr = (page) => page.waitForSelector('#panel-a .progress', { state: 'detached', timeout: 180_000 });
const skillCount = (page) => page.locator('#panel-b .skill-row').count();

try {
  console.log('1. デスクトップ（ダーク）: 初期表示とファイル選択');
  const page = await newPage({ width: 1600, height: 1000 });
  await page.screenshot({ path: `${out}/01-initial.png`, fullPage: true });
  await page.locator('#panel-a input[type=file]').setInputFiles(fixture);
  await page.waitForSelector('#panel-a .progress', { timeout: 10_000 });
  await page.screenshot({ path: `${out}/02-ocr-running.png` });
  await waitOcr(page);
  check((await skillCount(page)) === 20, `OCR で 20 項目が確認フォームに入る（${await skillCount(page)}）`);
  const plain = await page.locator('#panel-b input[aria-label="予測ダメージ"]').inputValue();
  check(plain === '847974', `予測ダメージ（無印）= 847974（${plain}）`);
  await page.screenshot({ path: `${out}/03-ocr-done.png`, fullPage: true });

  console.log('2. 基礎攻撃力を入れて結果を見る');
  await page.locator('#panel-c input[aria-label="基礎攻撃力"]').fill('53819');
  await page.waitForTimeout(300);
  const headline = await page.locator('#panel-d .result-card .stat-value').first().innerText();
  check(/\d/.test(headline) && headline !== '0', `通常攻撃の1ターン期待値が出る（${headline}）`);
  for (const d of await page.locator('#panel-d .result-card').first().locator('details').all()) await d.locator('summary').click();
  const chart = page.locator('#panel-d .chart svg').first();
  await chart.scrollIntoViewIfNeeded();
  const box = await chart.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
    await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.5, { steps: 4 });
  }
  const tipShown = await page
    .locator('#panel-d .tooltip')
    .first()
    .waitFor({ state: 'visible', timeout: 2_000 })
    .then(() => true)
    .catch(() => false);
  check(tipShown, '減衰グラフのツールチップが出る');
  await page.locator('#panel-d .result-card').first().screenshot({ path: `${out}/04-result-normal.png` });

  console.log('3. キャリブレーション: 仮説探索');
  await page.locator('#panel-e button', { hasText: '通りを探索' }).click();
  await page.waitForSelector('#panel-e table.hyp', { timeout: 20_000 });
  const rows = await page.locator('#panel-e table.hyp tbody tr').count();
  check(rows === 10, `仮説探索の上位10件（${rows}）`);
  await page.locator('#panel-e').screenshot({ path: `${out}/05-calibration.png` });
  await page.screenshot({ path: `${out}/06-desktop-full.png`, fullPage: true });

  console.log('4. 貼り付け（Ctrl+V 相当）');
  await page.locator('#panel-a button', { hasText: 'クリア' }).click();
  check((await skillCount(page)) === 0, 'クリアで項目が空になる');
  const b64 = readFileSync(fixture).toString('base64');
  await page.evaluate(async (data) => {
    const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'paste.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  }, b64);
  await page.waitForSelector('#panel-a .progress', { timeout: 10_000 });
  await waitOcr(page);
  check((await skillCount(page)) === 20, `貼り付けでも 20 項目（${await skillCount(page)}）`);

  console.log('5. ドラッグ&ドロップ');
  await page.locator('#panel-a button', { hasText: 'クリア' }).click();
  await page.evaluate(async (data) => {
    const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'drop.png', { type: 'image/png' }));
    window.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, b64);
  await page.waitForSelector('#panel-a .progress', { timeout: 10_000 });
  await waitOcr(page);
  check((await skillCount(page)) === 20, `ドロップでも 20 項目（${await skillCount(page)}）`);

  console.log('6. 共有リンクの往復');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('button', { hasText: '共有リンクをコピー' }).click();
  const shared = await page.evaluate(() => navigator.clipboard.readText());
  check(shared.includes('#s='), '共有リンクに入力が入る');
  const page2 = await newPage({ width: 1600, height: 1000 });
  await page2.goto(shared);
  await page2.waitForTimeout(500);
  check((await skillCount(page2)) === 20, `共有リンクを開くと同じ 20 項目（${await skillCount(page2)}）`);
  const atk = await page2.locator('#panel-c input[aria-label="基礎攻撃力"]').inputValue();
  check(atk === '53819', `共有リンクで基礎攻撃力も復元（${atk}）`);
  check(!page2.url().includes('#s='), '読み込んだあとアドレスバーのハッシュは消える');
  // 開いているタブに共有リンクを貼った場合（ハッシュだけが変わる）
  const page3 = await newPage({ width: 1600, height: 1000 });
  await page3.evaluate((h) => {
    window.location.hash = h;
  }, shared.slice(shared.indexOf('#')));
  await page3.waitForTimeout(500);
  check((await skillCount(page3)) === 20, `開いているタブでハッシュが変わっても読み込む（${await skillCount(page3)}）`);

  console.log('7. スマホ幅（ライト）');
  const mobile = await newPage({ width: 390, height: 844 }, 'light');
  await mobile.locator('#panel-a button', { hasText: 'サンプル値' }).click();
  await mobile.waitForTimeout(300);
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, `横スクロールが出ない（はみ出し ${overflow}px）`);
  await mobile.screenshot({ path: `${out}/07-mobile-light.png`, fullPage: true });
} finally {
  await browser.close();
}

if (errors.length > 0) {
  console.log('\nエラー:');
  for (const e of errors) console.log(' -', e);
  process.exit(1);
}
console.log('\nOK: スクショは', out);
