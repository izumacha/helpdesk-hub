// 招待受諾フォーム (Client Component)
import { AcceptInviteForm } from '@/features/auth/components/AcceptInviteForm';
// トークンの有効性を読み取り専用で判定する (消費はしない)
import { isInvitationAcceptable } from '@/features/auth/actions/accept-invitation';
// 共通ブランドマーク (シンボル + ワードマーク)
import { Logo } from '@/components/brand/Logo';

// /invite/[token] : 招待受諾ページ (公開・未認証で開ける)。
// トークンの有効性を表示時点で判定し、有効なときだけ受諾フォームを出す。
export default async function InvitePage({
  params,
}: {
  // Next.js 15 では params が Promise として渡される
  params: Promise<{ token: string }>;
}) {
  // URL パスから生トークンを取り出す
  const { token } = await params;
  // トークンが「今この瞬間」有効か、メール入力が必要かを判定する (消費はしない)
  const { acceptable, needsEmail } = await isInvitationAcceptable(token);

  return (
    // 画面全体: ログイン画面と揃えた柔らかなティールグラデ + 中央寄せ
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-gradient-to-br from-teal-50 via-white to-emerald-50 px-4 py-12">
      {/* 装飾用の薄いブラー円 (右上) */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 -right-24 h-72 w-72 rounded-full bg-teal-200/40 blur-3xl"
      />
      {/* 装飾用の薄いブラー円 (左下) */}
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-24 -left-24 h-72 w-72 rounded-full bg-emerald-200/40 blur-3xl"
      />

      {/* 受諾カード本体 (前面に出すため z-10) */}
      <div className="relative z-10 w-full max-w-md rounded-2xl bg-white/95 p-10 shadow-xl ring-1 ring-slate-100 backdrop-blur">
        {/* 上部: ブランドマーク + 見出し */}
        <div className="mb-8 flex flex-col items-center text-center">
          {/* シンボルのみ表示し、画面名は下の h1 に任せる */}
          <Logo showWordmark={false} size={44} />
          {/* ページの主見出し */}
          <h1 className="mt-4 text-2xl font-bold tracking-tight text-slate-900">
            HelpDesk Hub への招待
          </h1>
          {/* 補足コピー */}
          <p className="mt-3 text-sm text-slate-500">
            お名前とパスワードを設定すると利用を開始できます
          </p>
        </div>

        {acceptable ? (
          // 有効なトークン: 受諾フォームを表示
          <AcceptInviteForm token={token} needsEmail={needsEmail} />
        ) : (
          // 無効 / 失効 / 使用済み: 受諾できない旨を案内する (詮索余地を減らすため一括メッセージ)
          <p
            role="alert"
            className="rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-700 ring-1 ring-rose-200"
          >
            この招待リンクは無効か、有効期限が切れているか、既に使用されています。
            お手数ですが、管理者に新しい招待リンクの発行を依頼してください。
          </p>
        )}
      </div>
    </div>
  );
}
