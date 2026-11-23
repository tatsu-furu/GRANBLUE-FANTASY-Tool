// テスト・検証で共有する部品：リポジトリの静的サーバー・ブラウザの起動・スクリーンショット
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
export const root = process.env.REPO_ROOT || path.resolve(here, '..');   // 古戦場ツールのリポジトリ（kosenjou.html がある場所）
const shotsDir = process.env.SHOTS_DIR || '';                            // 空なら、スクリーンショットは撮らない（CI など）
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });

const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml' };

/** リポジトリを、そのまま配る静的サーバー（空いているポートで起動）。{ base, close } を返す */
export async function startServer() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(root, p);
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

/** Chromium を起動する（Playwright は、リポジトリの node_modules か、グローバルから探す） */
export async function launchBrowser() {
  const { chromium } = createRequire(import.meta.url)('playwright');
  return chromium.launch();
}

/** ページ全体のスクリーンショット。SHOTS_DIR が空なら、何もしない */
export async function shot(page, name) {
  if (!shotsDir) return;
  await page.screenshot({ path: path.join(shotsDir, name), fullPage: true });
}

/** 外への通信を止める（このサイトは、外部の通信をしない前提。止めても、画面のエラーが出ないことを確かめる） */
export function localOnly(page) {
  return page.route('**/*', (route) => (new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort()));
}
