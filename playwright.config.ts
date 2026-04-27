// Playwright の設定ヘルパーと既製のデバイス設定
import { defineConfig, devices } from '@playwright/test';

// Playwright の設定を defineConfig で記述してエクスポート
export default defineConfig({
  // E2E テストの置き場所
  testDir: './e2e',
  // テストファイル間を並列実行する (高速化)
  fullyParallel: true,
  // CI 環境で .only が残っていたら失敗にする (うっかり 1 件だけ実行を防ぐ)
  forbidOnly: !!process.env.CI,
  // CI ではリトライ 2 回、ローカルは 0 (フレーキー対策は CI のみ)
  retries: process.env.CI ? 2 : 0,
  // CI ではワーカー 1 (リソース節約)、ローカルは自動
  workers: process.env.CI ? 1 : undefined,
  // 結果レポートは HTML 形式
  reporter: 'html',
  // 全テスト共通のオプション
  use: {
    // 接続先 URL: 環境変数があればそれを優先、なければローカル dev サーバ
    baseURL: process.env.BASE_URL ?? 'http://localhost:3000',
    // 1 度目失敗時にトレース (実行記録) を取る → 失敗時のデバッグが楽
    trace: 'on-first-retry',
  },
  // プロジェクト設定 (ブラウザ別の組み合わせ)
  projects: [
    {
      // chromium のみ使う (Firefox / WebKit は省略してコスト削減)
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
