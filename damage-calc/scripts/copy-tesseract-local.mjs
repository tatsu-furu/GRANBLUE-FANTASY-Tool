// tesseract.js の worker・core・言語データ（jpn / eng）を public/tesseract-local/ にコピーする。
// CDN を使わずに動かしたいとき（ローカル検証・自前ホスト）に使う:
//   node scripts/copy-tesseract-local.mjs
//   VITE_TESS_BASE=./tesseract-local npm run dev   （またはビルド）
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'public/tesseract-local');
const pkgDir = (name) => dirname(require.resolve(`${name}/package.json`));

mkdirSync(join(out, 'core'), { recursive: true });
mkdirSync(join(out, 'lang'), { recursive: true });

copyFileSync(join(pkgDir('tesseract.js'), 'dist/worker.min.js'), join(out, 'worker.min.js'));
const core = pkgDir('tesseract.js-core');
for (const f of readdirSync(core).filter((f) => f.startsWith('tesseract-core'))) copyFileSync(join(core, f), join(out, 'core', f));
for (const lang of ['jpn', 'eng']) {
  copyFileSync(join(pkgDir(`@tesseract.js-data/${lang}`), '4.0.0_best_int', `${lang}.traineddata.gz`), join(out, 'lang', `${lang}.traineddata.gz`));
}
console.log('copied to', out);
