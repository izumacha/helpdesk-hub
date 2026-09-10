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
import type { Page } from '@playwright/test';

// seed が投入するテスト用アカウントの共通パスワード (ローカル/CI のシード専用の値)
export const SEED_PASSWORD = 'password123';

/**
 * seed 済みユーザーでログインし、ロール別の遷移先 (/dashboard か /tickets) まで待つ。
 * @param page Playwright のページ
 * @param email ログインするユーザー (既定はエージェント)
 */
export async function login(page: Page, email = 'agent1@example.com') {
  // ログインページへ遷移する
  await page.goto('/login');
  // メールアドレスを入力する
  await page.getByLabel(/メールアドレス|Email/i).fill(email);
  // 共通パスワードを入力する
  await page.getByLabel(/パスワード|Password/i).fill(SEED_PASSWORD);
  // ログインボタンを押す
  await page.getByRole('button', { name: /ログイン/i }).click();
  // ロール別の遷移先まで待機する
  await page.waitForURL(/\/dashboard|\/tickets/);
}
