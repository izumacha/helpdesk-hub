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

// ログイン後の遷移先 (ロールによって /dashboard か /tickets のどちらかになる)
const LANDED = /\/dashboard|\/tickets/;

/**
 * seed 済みユーザーでログインし、ロール別の遷移先 (/dashboard か /tickets) まで待つ。
 * @param page Playwright のページ
 * @param email ログインするユーザー (既定はエージェント)
 */
export async function login(page: Page, email = 'agent1@example.com') {
  // **ハイドレーション前のクリックに耐えるため、goto からまとめて再試行する**。
  // ログインフォームは `<form onSubmit={...}>` で action を持たないため、React の
  // ハイドレーション前に送信ボタンが押されると preventDefault が走らず、ブラウザが
  // ネイティブの GET を投げる (= 遷移しない)。Playwright は「成功したクリック」を
  // 再試行しないので、この形にしないと後続の待機がタイムアウトする。
  await expect(async () => {
    // ログインページへ遷移する (再試行のたびに入力状態ごとリセットする)
    await page.goto('/login');
    // **既にログイン済みなら proxy が /login から退避させる**ので、そのまま成功として抜ける。
    // (1 回目の試行が「認証は通ったが router.push が内側の制限時間に間に合わなかった」形で
    //  失敗した場合、2 回目以降はログインフォームが存在しない。ここで抜けないと
    //  入力欄を待ち続けてテスト全体のタイムアウトまでハングする)
    if (!/\/login/.test(page.url())) return;
    // メールアドレスを入力する
    await page.getByLabel(/メールアドレス|Email/i).fill(email);
    // 共通パスワードを入力する
    await page.getByLabel(/パスワード|Password/i).fill(SEED_PASSWORD);
    // ログインボタンを押す
    await page.getByRole('button', { name: /ログイン/i }).click();
    // ロール別の遷移先まで待機する (届かなければこの試行は失敗し、上の goto からやり直す)
    await page.waitForURL(LANDED, { timeout: 8_000 });
    // 再試行の総枠。呼び出し側のテスト制限時間に収まる値にしておく
    // (枠がテスト制限時間を超えていると 2 回目の試行が始まる前に打ち切られ、
    //  再試行そのものが機能しないまま「Test timeout」だけが報告される)
  }).toPass({ timeout: 20_000 });
}
