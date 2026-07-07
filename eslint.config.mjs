// Next.js が用意する Core Web Vitals 向け ESLint ルール集
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
// Next.js + TypeScript 用の ESLint ルール集
import nextTypescript from 'eslint-config-next/typescript';

// ESLint 9 のフラットコンフィグ (配列で複数のルール塊を結合する書き方)
const config = [
  {
    // Lint 対象から除外するパス (生成物・依存・成果物)
    ignores: [
      '.next/**', // Next.js のビルド出力
      'node_modules/**', // npm の依存パッケージ
      'src/generated/**', // Prisma の生成物
      'playwright-report/**', // Playwright のレポート
      'test-results/**', // E2E のスクリーンショット等
    ],
  },
  // Next 推奨ルールを展開してマージ
  ...nextCoreWebVitals,
  // TypeScript 向けルールを展開してマージ
  ...nextTypescript,
  {
    // 適用対象: src 配下の TypeScript / TSX ファイル全体
    files: ['src/**/*.{ts,tsx}'],
    // 例外: Prisma アダプタ層と Prisma クライアント生成箇所 (composition root) だけは生成物の直接 import を許可する
    ignores: ['src/data/adapters/prisma/**', 'src/lib/prisma.ts'],
    rules: {
      // _ プレフィックスの変数・引数は意図的な未使用として警告しない (TypeScript 慣習)
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_', // 関数引数の _ プレフィックスを無視
          varsIgnorePattern: '^_', // 変数宣言の _ プレフィックスを無視
          destructuredArrayIgnorePattern: '^_', // 分割代入の _ プレフィックスを無視
        },
      ],
      // 指定したモジュールへの import をエラー化するルール
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // Prisma の生成物 (@/generated/prisma 配下) への直接 import を禁止対象にする
              group: ['@/generated/prisma', '@/generated/prisma/*'],
              // 違反したときに開発者へ表示するメッセージ (代わりに使うべき場所を案内)
              message:
                'Prisma 生成物の直接 import は禁止。enum/型は正準である @/domain/types を使うこと。',
            },
          ],
        },
      ],
    },
  },
  {
    // src/lib/tenant-cache.ts と src/lib/tenant-plan.ts は @/lib/auth (next-auth) に依存しては
    // いけない。依存すると @/lib/tenant-plan を importOriginal() で部分モックする既存テスト
    // (tests/features/inbound-line-route.test.ts 等) が next-auth 内部依存の解決に失敗して壊れる
    // (回帰防止: コメントだけでなく lint でも機械的に検知できるようにする)
    files: ['src/lib/tenant-cache.ts', 'src/lib/tenant-plan.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/lib/auth'],
              message:
                'このファイルは @/lib/auth (next-auth) に依存できない。importOriginal() で部分モックする既存テストが next-auth 内部依存の解決に失敗して壊れるため (src/lib/tenant-cache.ts のコメント参照)。',
            },
          ],
        },
      ],
    },
  },
];

// ESLint が読み取れるよう default export
export default config;
