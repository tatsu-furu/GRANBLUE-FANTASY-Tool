import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // 相対パスにして、サイトのどの階層（/damage/ など）に置いても動くようにする
  base: './',
  plugins: [react()],
  build: {
    outDir: '../damage',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['**/*.ocr.test.ts', 'node_modules/**'],
    environment: 'node',
  },
});
