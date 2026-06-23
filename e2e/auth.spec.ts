// Playwright のテスト DSL (test = it, expect = アサーション)
import { test, expect } from '@playwright/test';
// マジックリンクの outbox ファイルを読むため
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Console EmailSender が書き出すアウトボックスファイル (プロジェクトルート直下)
const OUTBOX_PATH = path.join(process.cwd(), '.magic-link-outbox.jsonl');

// outbox から指定メール宛の URL を取得する。
// - 並列テスト同士が同じファイルに append するので、テスト間でファイルをクリアしない
// - 指定 sinceMs より新しい entry の中から、最後 (= 直近) のものを返す
// - 最大 retries 回までポーリング (100ms 間隔)
async function readLastMagicLinkUrl(
  email: string,
  sinceMs: number,
  retries = 30,
): Promise<string> {
  // 指定回数まで 100ms 間隔でファイルをチェック
  for (let i = 0; i < retries; i++) {
    if (existsSync(OUTBOX_PATH)) {
      // ファイル全体を読み、行単位で解析
      const lines = readFileSync(OUTBOX_PATH, 'utf8').trim().split('\n');
      // 末尾から走査して該当メール宛 + sinceMs より新しい URL を探す
      for (let j = lines.length - 1; j >= 0; j--) {
        const line = lines[j];
        if (!line) continue;
        try {
          // JSON 行を解析
          const entry = JSON.parse(line);
          // 対象メール宛で sinceMs より新しいなら text 本文から URL を抽出
          if (
            entry.to === email &&
            typeof entry.text === 'string' &&
            typeof entry.sentAt === 'string' &&
            new Date(entry.sentAt).getTime() >= sinceMs
          ) {
            const match = entry.text.match(/https?:\/\/\S+token=[A-Za-z0-9_-]+/);
            if (match) return match[0];
          }
        } catch {
          // 壊れた行はスキップ (並列 append の中途半端な行など)
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
  // 新フロー: GET → HTML 確認ページ表示 → 「ログインする」ボタンクリック(POST) → 保護ページへ
  // (メールゲートウェイのプリフェッチ対策として GET ではトークンを消費しない設計のため)
  test('マジックリンクで認証できる', async ({ page }) => {
    // テスト開始時刻を控えておき、この時刻以降に書かれた outbox エントリだけを採用する
    // (並列テストが同じファイルに append するので、古い entry や別テストの entry を拾わないため)
    const since = Date.now();
    // メールタブから要求
    await page.goto('/login');
    await page.getByRole('tab', { name: 'メールでログイン' }).click();
    await page.getByLabel(/メールアドレス/i).fill('agent1@example.com');
    await page.getByRole('button', { name: 'ログインリンクを送る' }).click();
    // 確認メッセージが出たことを待つ (= サーバー側の send 完了 = outbox 書き込み完了)
    await expect(page.getByText('メールを確認してください')).toBeVisible();
    // outbox から since 以降に書かれた agent1 宛 URL を取り出す
    const url = await readLastMagicLinkUrl('agent1@example.com', since);
    // ブラウザでリンクを開く (GET): メールゲートウェイ対策でトークンは消費されず HTML 確認ページが返る
    await page.goto(url);
    // 「ログインする」ボタンが表示されること (GET は確認ページを返すのみ)
    await expect(page.getByRole('button', { name: 'ログインする' })).toBeVisible();
    // ボタンをクリックして POST 送信する (= ここで初めてトークンが消費され認証が完了する)
    await page.getByRole('button', { name: 'ログインする' }).click();
    // 役割ベースで dashboard か tickets に遷移していること
    await expect(page).toHaveURL(/\/dashboard|\/tickets/);
  });

  // 不正なトークンでは ?error=magic-link-invalid 付きで /login に戻されること
  // 新フロー: GET → HTML 確認ページ → ボタンクリック(POST) → 不正判定 → /login にリダイレクト
  test('不正なマジックリンクトークンはログイン画面に戻る', async ({ page }) => {
    // でたらめなトークンで callback を GET で開く → HTML 確認ページが返る (即リダイレクトしない)
    await page.goto('/api/auth/magic-link/callback?token=invalid-token-xxx');
    // 「ログインする」ボタンが表示されること (GET では検証せず確認ページのみ返す)
    await expect(page.getByRole('button', { name: 'ログインする' })).toBeVisible();
    // ボタンをクリックして POST 送信する (= ここで初めてトークン検証が実行される)
    await page.getByRole('button', { name: 'ログインする' }).click();
    // 不正トークンなので /login に戻されていること
    await expect(page).toHaveURL(/\/login(\?|$)/);
    // エラー文言が見えること
    await expect(page.getByText('ログインリンクが無効です')).toBeVisible();
  });
});
