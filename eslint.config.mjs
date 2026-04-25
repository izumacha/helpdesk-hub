// Next.js が用意する Core Web Vitals 向け ESLint ルール集
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
// Next.js + TypeScript 用の ESLint ルール集
import nextTypescript from 'eslint-config-next/typescript';

// ESLint 9 のフラットコンフィグ (配列で複数のルール塊を結合する書き方)
const config = [
  {
    // Lint 対象から除外するパス (生成物・依存・成果物)
    ignores: [
      '.next/**',              // Next.js のビルド出力
      'node_modules/**',       // npm の依存パッケージ
      'src/generated/**',      // Prisma の生成物
      'playwright-report/**',  // Playwright のレポート
      'test-results/**',       // E2E のスクリーンショット等
    ],
  },
  // Next 推奨ルールを展開してマージ
  ...nextCoreWebVitals,
  // TypeScript 向けルールを展開してマージ
  ...nextTypescript,
];

// ESLint が読み取れるよう default export
export default config;
