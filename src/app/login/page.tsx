// クライアントコンポーネントのタブ切替コンテナを取り込む
import { LoginTabs } from '@/features/auth/components/LoginTabs';
// 共通ブランドマーク (シンボル + ワードマーク)
import { Logo } from '@/components/brand/Logo';
// セルフサーブサインアップ (§7.1) への導線
import Link from 'next/link';

// ?error=... を読み取って初期エラーメッセージを決めるためのマップ
// 値はクライアントから操作不能 (URL クエリでしか入らない) なので enum 的に固定文言を返す
function getInitialError(errorCode: string | undefined): string | undefined {
  // 想定済みコードだけ日本語に変換し、それ以外は未表示
  if (errorCode === 'magic-link-invalid') {
    return 'ログインリンクが無効です。もう一度メール送信からやり直してください。';
  }
  // SSO (SAML) が利用不可 (未設定・無効・プラン外など)
  if (errorCode === 'sso-unavailable') {
    return 'SSO ログインは現在利用できません。管理者にお問い合わせください。';
  }
  // SSO の応答検証に失敗 (署名不正・期限切れ・なりすまし等)
  if (errorCode === 'sso-invalid') {
    return 'SSO ログインに失敗しました。お手数ですが、もう一度お試しください。';
  }
  // SSO は成功したが、組織内に対応するメンバーが見つからない
  if (errorCode === 'sso-no-user') {
    return 'SSO は成功しましたが、組織にあなたのアカウントが見つかりません。管理者に招待を依頼してください。';
  }
  return undefined;
}

// /login ページ本体 (Server Component)。?error クエリを受け取って LoginTabs に渡す
export default async function LoginPage({
  searchParams,
}: {
  // Next.js 15 では searchParams が Promise として渡される
  searchParams: Promise<{ error?: string }>;
}) {
  // クエリを await で取り出す
  const { error } = await searchParams;
  // 初期エラー文言 (マジックリンク失敗から戻った直後など)
  const initialError = getInitialError(error);

  return (
    // 画面全体: 健診センター風の柔らかなティールグラデ + 中央寄せ
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-gradient-to-br from-teal-50 via-white to-emerald-50 px-4 py-12">
      {/* 装飾用の薄いブラー円 (右上) ─ 病院ロビーのような奥行き感を演出 */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 -right-24 h-72 w-72 rounded-full bg-teal-200/40 blur-3xl"
      />
      {/* 装飾用の薄いブラー円 (左下) */}
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-24 -left-24 h-72 w-72 rounded-full bg-emerald-200/40 blur-3xl"
      />

      {/* ログインカード本体 (前面に出すため z-10) */}
      <div className="relative z-10 w-full max-w-md rounded-2xl bg-white/95 p-10 shadow-xl ring-1 ring-slate-100 backdrop-blur">
        {/* 上部: ブランドマーク + キャッチコピー */}
        <div className="mb-8 flex flex-col items-center text-center">
          {/* シンボルのみ表示し、画面名は下の h1 に任せる */}
          <Logo showWordmark={false} size={44} />
          {/* ページの主見出し (E2E とスクリーンリーダーが画面名を認識できるようにする) */}
          <h1 className="mt-4 text-2xl font-bold tracking-tight text-slate-900">HelpDesk Hub</h1>
          {/* 補足コピー (落ち着いたグレー) */}
          <p className="mt-3 text-sm text-slate-500">社内ヘルプデスクへようこそ</p>
        </div>

        {/* タブ切替 + 各フォーム本体 */}
        <LoginTabs initialError={initialError} />

        {/* セルフサーブサインアップ (§7.1) への導線: まだ組織を作っていない見込み客向け */}
        <p className="mt-6 text-center text-xs text-slate-400">
          初めてご利用の方は
          <Link href="/signup" className="mx-1 text-teal-700 underline hover:text-teal-800">
            サインアップ
          </Link>
          してください
        </p>
        {/* フッター: サポート連絡先風の補足 (装飾) */}
        <p className="mt-2 text-center text-xs text-slate-400">
          ログインに関するお問い合わせは管理者までご連絡ください
        </p>
      </div>
    </div>
  );
}
