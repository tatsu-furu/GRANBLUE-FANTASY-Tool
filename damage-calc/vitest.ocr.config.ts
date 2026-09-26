import { defineConfig } from 'vitest/config';

// OCR のテストとキャリブレーションのレポートは遅い・出力が多いので通常の `npm test` とは分ける
export default defineConfig({
  test: {
    include: ['tests/**/*.ocr.test.ts', 'tests/**/*.report.test.ts'],
    environment: 'node',
    testTimeout: 600_000,
    hookTimeout: 600_000,
    pool: 'forks',
  },
});
