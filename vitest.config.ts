// Vitest 設定ヘルパー (defineConfig は補完を効かせるため)
import { defineConfig } from 'vitest/config';
// パス解決用 (Node 標準 path モジュール)
import path from 'path';

// Vitest の設定を defineConfig で記述してエクスポート
export default defineConfig({
  // テスト全体に効くオプション
  test: {
    // Node 環境でテストを実行 (DOM が要るときは 'jsdom' に変える)
    environment: 'node',
    // 拾うテストファイルのパターン (tests/ 配下の *.test.ts のみ)
    include: ['tests/**/*.test.ts'],
    // 契約テスト (DB 必須) は通常実行から除外する。
    // `npm run test:contract` が明示的にファイルを渡すため、そちらでのみ動く。
    // RUN_PRISMA_CONTRACT フラグなしで `npm run test` を実行するとモジュール解決エラーが
    // 起きる (生成済み @/generated/prisma が必要) ため、ここで除外してローカル開発体験を保つ。
    exclude: ['tests/data/*.contract.prisma.test.ts'],
  },
  // モジュール解決設定
  resolve: {
    // パスエイリアス: '@/foo' を 'src/foo' に解決 (tsconfig と一致させる)
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
