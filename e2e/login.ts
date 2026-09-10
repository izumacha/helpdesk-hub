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
import { actUntil } from './hydration';

// seed が投入するテスト用アカウントの共通パスワード (ローカル/CI のシード専用の値)
export const SEED_PASSWORD = 'password123';

// ログイン後の遷移先 (ロールによって /dashboard か /tickets のどちらかになる)
const LANDED = /\/dashboard|\/tickets/;

// 1 回の試行の中で使う上限 (ミリ秒)。合計が下の総枠の半分以下になるようにして、
// 「1 回目の試行だけで枠を使い切り再試行が走らない」形を避ける (hydration.ts の注意書き)
// ログインページへの遷移の上限 (既定の 30 秒のままだと総枠を単独で超えうる)
const NAV_TIMEOUT_MS = 5_000;
// ログインフォームが現れるまでの上限 (クッキーを捨てた直後なので本来は即座に出る)
const FORM_WAIT_MS = 3_000;
// クリック後、遷移先へ着くまでの上限。**期待される失敗 (ハイドレーション前のクリックが
// 効かない) はここだけが枠を使う**ので、総枠はこの値の 2 回分＋余白を確保してある
const LANDING_WAIT_MS = 8_000;

/**
 * ログインの再試行に使う総枠 (ミリ秒)。
 *
 * **呼び出し側のテスト制限時間はこの値より十分大きくすること。** 枠のほうが大きいと
 * 2 回目の試行が始まる前にテストごと打ち切られ、再試行が機能しないまま
 * 「Test timeout」だけが報告される (この値を export しているのは、呼び出し側が
 * 制限時間をこの値から導けるようにするため。§6 マジックナンバーを散らさない)。
 *
 * /code-review ultra 指摘対応: 以前の 30 秒は **Playwright の既定のテスト制限時間と
 * ちょうど同じ**で、`playwright.config.ts` に `timeout` を置いていない以上、
 * 制限時間を上書きしない呼び出し側では上の前提が既定で破れていた
 * (このモジュールは「新しいスペックはこれを使うこと」と案内しているので、
 * 前提を満たすかどうかを各呼び出し側の記憶に頼らせない)。既定より小さい値にして、
 * 上書きしない呼び出し側でも 2 回目の試行が必ず始まるようにする。
 */
export const LOGIN_RETRY_BUDGET_MS = 20_000;

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
    // ログインページへ遷移する (上限を明示。既定の 30 秒だと総枠を単独で超えうる)
    await page.goto('/login', { timeout: NAV_TIMEOUT_MS });
    // メールアドレス欄を指す
    const emailField = page.getByLabel(/メールアドレス|Email/i);
    // **フォームが出たことを先に確かめる**。クッキーの削除と、直前の試行が残した
    // 遷移が競合してセッションが生き残ると、proxy が /login から退避させるので
    // フォームは現れない。ここで落とせばこの試行は失敗し、次の試行が
    // もう一度クッキーを捨ててやり直す (入力欄を待ち続けてハングしない)
    await expect(emailField).toBeVisible({ timeout: FORM_WAIT_MS });
    // メールアドレスを入力する
    await emailField.fill(email);
    // 共通パスワードを入力する
    await page.getByLabel(/パスワード|Password/i).fill(SEED_PASSWORD);
    // ログインボタンを押す (ハイドレーション前ならこのクリックは効かない)
    await page.getByRole('button', { name: /ログイン/i }).click();
  };
  // 遷移先へ着いたことの確認 (着かなければ試行をやり直す)
  const landed = async () => {
    // ロール別の遷移先まで待機する
    await page.waitForURL(LANDED, { timeout: LANDING_WAIT_MS });
  };
  // 着地するまで、枠の範囲でログインを繰り返す
  // (成立した時点で遷移先に着いているので、ここで URL を再表明しても必ず通る＝
  //  検査になっていないため置かない。§6 デッドコードを残さない)
  await actUntil(attempt, landed, LOGIN_RETRY_BUDGET_MS);
}
