// サインアップ完了フォーム (Client Component)
import { CompleteSignupForm } from '@/features/auth/components/CompleteSignupForm';
// トークンの有効性を読み取り専用で判定する (消費はしない)。
// /code-review ultra 指摘対応 (2026-07-19): 'use server' モジュールから import すると
// ヘルパーが公開エンドポイント化するため、Server Action ではない lib モジュールから読む
import { isSignupAcceptable } from '@/lib/signup-acceptance';
// 共通ブランドマーク (シンボル + ワードマーク)
import { Logo } from '@/components/brand/Logo';

// /signup/complete : サインアップ完了ページ (公開・未認証で開ける)。
// トークンの有効性を表示時点で判定し、有効なときだけ完了フォームを出す
// (invite/[token]/page.tsx と同じ設計)。
export default async function SignupCompletePage({
  searchParams,
}: {
  // Next.js 15 では searchParams が Promise として渡される
  searchParams: Promise<{ token?: string }>;
}) {
  // URL クエリから生トークンを取り出す
  const { token } = await searchParams;
  // トークンが「今この瞬間」有効かを判定する (消費はしない)。token 欠落は無効扱いにする
  const acceptable = token ? await isSignupAcceptable(token) : false;

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

      {/* 完了カード本体 (前面に出すため z-10) */}
      <div className="relative z-10 w-full max-w-md rounded-2xl bg-white/95 p-10 shadow-xl ring-1 ring-slate-100 backdrop-blur">
        {/* 上部: ブランドマーク + 見出し */}
        <div className="mb-8 flex flex-col items-center text-center">
          {/* シンボルのみ表示し、画面名は下の h1 に任せる */}
          <Logo showWordmark={false} size={44} />
          {/* ページの主見出し */}
          <h1 className="mt-4 text-2xl font-bold tracking-tight text-slate-900">
            サインアップを完了する
          </h1>
          {/* 補足コピー */}
          <p className="mt-3 text-sm text-slate-500">
            組織名とお名前・パスワードを設定してください
          </p>
        </div>

        {acceptable && token ? (
          // 有効なトークン: 完了フォームを表示
          <CompleteSignupForm token={token} />
        ) : (
          // 無効 / 失効 / 使用済み: 完了できない旨を案内する (詮索余地を減らすため一括メッセージ)
          <p
            role="alert"
            className="rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-700 ring-1 ring-rose-200"
          >
            このリンクは無効か、有効期限が切れているか、既に使用されています。
            お手数ですが、サインアップからやり直してください。
          </p>
        )}
      </div>
    </div>
  );
}
