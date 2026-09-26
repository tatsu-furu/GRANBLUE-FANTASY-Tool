import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => ({
  // 相対パスにして、サイトのどの階層（/damage/ など）に置いても動くようにする
  base: './',
  plugins: [react()],
  // public/ には検証用の tesseract 一式（34MB, git 管理外）を置くことがある。
  // 本番ビルドでは VITE_TESS_BASE を指定して自前ホストするときだけ出力に含める
  publicDir: command === 'serve' || process.env.VITE_TESS_BASE ? 'public' : false,
  build: {
    outDir: '../damage',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['**/*.ocr.test.ts', '**/*.report.test.ts', 'node_modules/**'],
    environment: 'node',
  },
}));
