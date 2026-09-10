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
// ハイドレーション前のクリックに耐える共通の再試行ヘルパー
import { actUntil, HYDRATION_ATTEMPT_MS } from './hydration';

// seed が投入するテスト用アカウントの共通パスワード (ローカル/CI のシード専用の値)
export const SEED_PASSWORD = 'password123';

// ログイン後の遷移先 (ロールによって /dashboard か /tickets のどちらかになる)
const LANDED = /\/dashboard|\/tickets/;

/**
 * ログインの再試行に使う総枠 (ミリ秒)。
 *
 * **呼び出し側のテスト制限時間はこの値より十分大きくすること。** 枠のほうが大きいと
 * 2 回目の試行が始まる前にテストごと打ち切られ、再試行が機能しないまま
 * 「Test timeout」だけが報告される (この値を export しているのは、呼び出し側が
 * 制限時間をこの値から導けるようにするため。§6 マジックナンバーを散らさない)。
 */
export const LOGIN_RETRY_BUDGET_MS = 30_000;

/**
 * seed 済みユーザーでログインし、ロール別の遷移先 (/dashboard か /tickets) まで待つ。
 * @param page Playwright のページ
 * @param email ログインするユーザー (既定はエージェント)
 */
export async function login(page: Page, email = 'agent1@example.com') {
  // 1 回の試行 (何度実行しても同じ結果になるよう、毎回まっさらな状態から始める)
  const attempt = async () => {
    // **既存のセッションを必ず捨てる**。
    // /code-review ultra 指摘対応: 以前は「/login へ行って退避させられたら成功」と
    // していたが、それだと *別のユーザー* でログインし直したいときに前のセッションが
    // そのまま残り、ログインしたつもりのない権限でテストが進んでしまう
    // (RBAC・テナント分離のスペックが偽の緑になる、最も危険な壊れ方)。
    // 併せて「1 回目で認証だけ通って遷移待ちに間に合わなかった」場合の
    // 再試行も、ここでクッキーを捨てることで素直にやり直せる
    await page.context().clearCookies();
    // ログインページへ遷移する (クッキーを捨てた直後なので必ずフォームが出る)
    await page.goto('/login');
    // メールアドレスを入力する
    await page.getByLabel(/メールアドレス|Email/i).fill(email);
    // 共通パスワードを入力する
    await page.getByLabel(/パスワード|Password/i).fill(SEED_PASSWORD);
    // ログインボタンを押す (ハイドレーション前ならこのクリックは効かない)
    await page.getByRole('button', { name: /ログイン/i }).click();
  };
  // 遷移先へ着いたことの確認 (着かなければ試行をやり直す)
  const landed = async () => {
    // ロール別の遷移先まで待機する
    await page.waitForURL(LANDED, { timeout: HYDRATION_ATTEMPT_MS });
  };
  // 着地するまで、枠の範囲でログインを繰り返す
  await actUntil(attempt, landed, LOGIN_RETRY_BUDGET_MS);
  // 念のため最終状態を表明しておく (失敗時にどこで止まったかが読み取りやすくなる)
  await expect(page).toHaveURL(LANDED);
}
