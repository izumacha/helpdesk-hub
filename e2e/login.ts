// E2E 共通のログインヘルパー。
//
// /code-review ultra 指摘対応 (2026-09-10): 同じ login 関数が各スペックへ 10 回以上
// 書き写されており、ログイン方法を変えるとき (CLAUDE.md が挙げているマジックリンク移行など)
// 同一のコピーを全部直す必要がある形になっていた (§6 DRY)。共有モジュールを置ける形は
// e2e/cleanup.ts が既に作ってあるので、そこへ揃えて 1 か所に集約する。
//
// **既存スペックの移行は別 PR で行う** (このモジュールを導入した PR の差分に
// 無関係な 10 ファイルの書き換えを混ぜないため。§6 変更は最小スコープに保つ)。
// 新しいスペックはこのヘルパーを使うこと。
import { expect, type Page } from '@playwright/test';

// seed が投入するテスト用アカウントの共通パスワード (ローカル/CI のシード専用の値)
export const SEED_PASSWORD = 'password123';

/**
 * seed 済みユーザーでログインし、ロール別の遷移先 (/dashboard か /tickets) まで待つ。
 * @param page Playwright のページ
 * @param email ログインするユーザー (既定はエージェント)
 */
export async function login(page: Page, email = 'agent1@example.com') {
  // **ハイドレーション前のクリックに耐える形で 1 手順ごとやり直す** (6 巡目レビュー指摘)。
  // ログインフォームは `<form onSubmit={...}>` で action を持たないため、React の
  // ハイドレーション前に送信ボタンが押されると preventDefault が走らず、ブラウザが
  // ネイティブの GET を投げる (= 遷移せず、しかも入力値が URL に載る)。
  // Playwright は「成功したクリック」を再試行しないので、後続の待機がタイムアウトする。
  // goto からやり直す形で丸ごと再試行すれば、その 1 回目が外れても URL は次の goto で
  // 上書きされ、ハイドレーション済みの状態で必ずやり直せる
  await expect(async () => {
    // ログインページへ遷移する (再試行のたびに入力状態ごとリセットする)
    await page.goto('/login');
    // JS チャンクの読み込みが落ち着くまで待つ (ハイドレーション前クリックの窓を狭める)
    await page.waitForLoadState('networkidle');
    // メールアドレスを入力する
    await page.getByLabel(/メールアドレス|Email/i).fill(email);
    // 共通パスワードを入力する
    await page.getByLabel(/パスワード|Password/i).fill(SEED_PASSWORD);
    // ログインボタンを押す
    await page.getByRole('button', { name: /ログイン/i }).click();
    // ロール別の遷移先まで待機する (届かなければこの試行は失敗し、上の goto からやり直す)
    await page.waitForURL(/\/dashboard|\/tickets/, { timeout: 10_000 });
  }).toPass({ timeout: 45_000 });
}
