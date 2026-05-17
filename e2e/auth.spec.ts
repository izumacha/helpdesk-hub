// Playwright のテスト DSL (test = it, expect = アサーション)
import { test, expect } from '@playwright/test';
// マジックリンクの outbox ファイルを読むため
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Console EmailSender が書き出すアウトボックスファイル (プロジェクトルート直下)
const OUTBOX_PATH = path.join(process.cwd(), '.magic-link-outbox.jsonl');

// outbox から指定メール宛の最後の URL を取得する。最大 retries 回までポーリングする
async function readLastMagicLinkUrl(email: string, retries = 20): Promise<string> {
  // 指定回数まで 100ms 間隔でファイルをチェック
  for (let i = 0; i < retries; i++) {
    if (existsSync(OUTBOX_PATH)) {
      // ファイル全体を読み、行単位で解析
      const lines = readFileSync(OUTBOX_PATH, 'utf8').trim().split('\n');
      // 末尾から走査して該当メール宛の URL を探す
      for (let j = lines.length - 1; j >= 0; j--) {
        const line = lines[j];
        if (!line) continue;
        try {
          // JSON 行を解析
          const entry = JSON.parse(line);
          // 対象メール宛なら text 本文から URL を抽出
          if (entry.to === email && typeof entry.text === 'string') {
            const match = entry.text.match(/https?:\/\/\S+token=[A-Za-z0-9_-]+/);
            if (match) return match[0];
          }
        } catch {
          // 壊れた行はスキップ
        }
      }
    }
    // 100ms 待ってからリトライ
    await new Promise((r) => setTimeout(r, 100));
  }
  // 見つからなければエラー
  throw new Error(`outbox に ${email} 宛の magic link が見つかりませんでした`);
}

// 認証関連のシナリオをまとめるグループ
test.describe('認証', () => {
  // 未ログイン状態でログインページに各フォーム要素が表示されること
  test('ログインページが表示される', async ({ page }) => {
    // ログインページへ遷移
    await page.goto('/login');
    // 見出しが「ログイン」または「HelpDesk」を含む (大文字小文字無視)
    await expect(page.getByRole('heading', { name: /ログイン|HelpDesk/i })).toBeVisible();
    // メールアドレス入力欄 (パスワードタブの方が既定で可視) が表示される
    await expect(page.getByLabel(/メールアドレス|Email/i).first()).toBeVisible();
    // パスワード入力欄が表示される
    await expect(page.getByLabel(/パスワード|Password/i)).toBeVisible();
  });

  // 未ログインで保護ページへ行くと middleware がログインへ飛ばす
  test('未認証でダッシュボードにアクセスするとログインページにリダイレクトされる', async ({
    page,
  }) => {
    // 認証必須のダッシュボードへ直接アクセス
    await page.goto('/dashboard');
    // URL が /login を含むこと (リダイレクトされた)
    await expect(page).toHaveURL(/\/login/);
  });

  // 正しいメール/パスワードでログインに成功し、保護ページへ遷移する
  test('有効な認証情報でログインできる', async ({ page }) => {
    // ログインページへ遷移
    await page.goto('/login');
    // パスワードタブの入力欄に直接フォーカスして入力 (パスワードタブが既定で可視)
    await page.getByLabel(/メールアドレス|Email/i).first().fill('agent1@example.com');
    // 共通パスワードを入力
    await page.getByLabel(/パスワード|Password/i).fill('password123');
    // ログインボタンを押す (タブボタンと衝突しないように name で厳密に絞る)
    await page.getByRole('button', { name: /^ログイン(中|する)?$/ }).click();
    // ダッシュボードまたはチケット一覧にリダイレクトされる (役割で分岐)
    await expect(page).toHaveURL(/\/dashboard|\/tickets/);
  });

  // 認証情報が誤っている場合は /login のままに留まる
  test('無効な認証情報でログインが失敗する', async ({ page }) => {
    // ログインページへ遷移
    await page.goto('/login');
    // 存在しないメールアドレスを入力 (パスワードタブが既定で可視)
    await page.getByLabel(/メールアドレス|Email/i).first().fill('wrong@example.com');
    // 誤ったパスワードを入力
    await page.getByLabel(/パスワード|Password/i).fill('wrongpassword');
    // ログインボタンを押す (タブボタンと衝突しないように name で厳密に絞る)
    await page.getByRole('button', { name: /^ログイン(中|する)?$/ }).click();
    // 失敗時は /login にとどまる
    await expect(page).toHaveURL(/\/login/);
  });

  // メールでログインタブに切り替えると、メール入力フォームが表示されること
  test('メールでログインタブに切り替えるとメール入力が表示される', async ({ page }) => {
    // ログインページへ遷移
    await page.goto('/login');
    // タブを切り替える
    await page.getByRole('tab', { name: 'メールでログイン' }).click();
    // 「ログインリンクを送る」ボタンが見えること
    await expect(page.getByRole('button', { name: 'ログインリンクを送る' })).toBeVisible();
    // 説明文 (登録済みメールアドレス案内) が見えること
    await expect(page.getByText('登録済みのメールアドレス')).toBeVisible();
  });

  // マジックリンクを要求すると確認メッセージが表示されること
  test('マジックリンクを要求すると確認メッセージが表示される', async ({ page }) => {
    // テスト前に outbox を空にする (前のテストの行と混ざらないように)
    writeFileSync(OUTBOX_PATH, '');
    // ログインページへ遷移し、メールタブへ切り替え
    await page.goto('/login');
    await page.getByRole('tab', { name: 'メールでログイン' }).click();
    // シードユーザーのメールアドレスを入力
    await page.getByLabel(/メールアドレス/i).fill('requester1@example.com');
    // 送信
    await page.getByRole('button', { name: 'ログインリンクを送る' }).click();
    // 確認メッセージが表示される
    await expect(page.getByText('メールを確認してください')).toBeVisible();
    // 入力したメールアドレスがメッセージ内に表示される
    await expect(page.getByText('requester1@example.com')).toBeVisible();
  });

  // マジックリンクで実際に認証が完了し、保護ページへ遷移すること
  test('マジックリンクで認証できる', async ({ page }) => {
    // 直前の outbox をクリア (この後で再度書かれる)
    writeFileSync(OUTBOX_PATH, '');
    // メールタブから要求
    await page.goto('/login');
    await page.getByRole('tab', { name: 'メールでログイン' }).click();
    await page.getByLabel(/メールアドレス/i).fill('agent1@example.com');
    await page.getByRole('button', { name: 'ログインリンクを送る' }).click();
    // 確認メッセージが出たことを待つ (= サーバー側の send 完了 = outbox 書き込み完了)
    await expect(page.getByText('メールを確認してください')).toBeVisible();
    // outbox から URL を取り出す
    const url = await readLastMagicLinkUrl('agent1@example.com');
    // ブラウザでクリック (本来メーラーから踏む経路)
    await page.goto(url);
    // 役割ベースで dashboard か tickets に遷移していること
    await expect(page).toHaveURL(/\/dashboard|\/tickets/);
  });

  // 不正なトークンでは ?error=magic-link-invalid 付きで /login に戻されること
  test('不正なマジックリンクトークンはログイン画面に戻る', async ({ page }) => {
    // でたらめなトークンで callback を叩く
    await page.goto('/api/auth/magic-link/callback?token=invalid-token-xxx');
    // /login に戻されていること
    await expect(page).toHaveURL(/\/login(\?|$)/);
    // エラー文言が見えること
    await expect(page.getByText('ログインリンクが無効です')).toBeVisible();
  });
});
