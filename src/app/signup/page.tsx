// サインアップ (メール入力) フォーム (Client Component)
import { RequestSignupForm } from '@/features/auth/components/RequestSignupForm';
// 共通ブランドマーク (シンボル + ワードマーク)
import { Logo } from '@/components/brand/Logo';
// ログイン画面に戻る導線
import Link from 'next/link';

// /signup : セルフサーブサインアップの入口ページ (公開・未認証で開ける)。
// docs/smb-dx-pivot-plan.md §7.1「30 分で運用開始」シナリオの第一歩
// 「サインアップ（メールアドレスのみ、マジックリンク）」に対応する。
export default function SignupPage() {
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

      {/* サインアップカード本体 (前面に出すため z-10) */}
      <div className="relative z-10 w-full max-w-md rounded-2xl bg-white/95 p-10 shadow-xl ring-1 ring-slate-100 backdrop-blur">
        {/* 上部: ブランドマーク + 見出し */}
        <div className="mb-8 flex flex-col items-center text-center">
          {/* シンボルのみ表示し、画面名は下の h1 に任せる */}
          <Logo showWordmark={false} size={44} />
          {/* ページの主見出し */}
          <h1 className="mt-4 text-2xl font-bold tracking-tight text-slate-900">
            HelpDesk Hub をはじめる
          </h1>
          {/* 補足コピー */}
          <p className="mt-3 text-sm text-slate-500">30 分で運用を開始できます</p>
        </div>

        {/* メール入力フォーム本体 */}
        <RequestSignupForm />

        {/* 既存アカウントの案内 (ログイン画面への導線) */}
        <p className="mt-6 text-center text-xs text-slate-400">
          既にアカウントをお持ちの方は
          <Link href="/login" className="mx-1 text-teal-700 underline hover:text-teal-800">
            ログイン
          </Link>
          してください
        </p>
      </div>
    </div>
  );
}
