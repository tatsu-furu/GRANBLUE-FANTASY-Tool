import { defineConfig } from 'vitest/config';

// OCR のテストは遅いので通常の `npm test` とは分ける（`npm run test:ocr`）
export default defineConfig({
  test: {
    include: ['tests/**/*.ocr.test.ts'],
    environment: 'node',
    testTimeout: 600_000,
    hookTimeout: 600_000,
    pool: 'forks',
  },
});
