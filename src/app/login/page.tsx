'use client';

// クライアント側のサインイン関数とセッション再取得関数
import { signIn, getSession } from 'next-auth/react';
// ログイン後のページ遷移に使う
import { useRouter } from 'next/navigation';
// 入力状態 (エラー/ローディング) を持つための React フック
import { useState } from 'react';
// エージェント権限判定
import { isAgent } from '@/lib/role';
// 共通ブランドマーク (シンボル + ワードマーク)
import { Logo } from '@/components/brand/Logo';

// /login : ログインフォームページ
export default function LoginPage() {
  // クライアント側のページ遷移用ルーター
  const router = useRouter();
  // エラー文言 (ログイン失敗時に表示)
  const [error, setError] = useState('');
  // 送信中フラグ (連打防止 + ボタン文言切替)
  const [loading, setLoading] = useState(false);

  // フォーム送信時のハンドラ (ログイン処理)
  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    // ブラウザ既定のページ遷移を抑止
    e.preventDefault();
    // 直前のエラー表示を消す
    setError('');
    // ローディング表示開始
    setLoading(true);

    // フォーム要素から入力値を取得
    const form = e.currentTarget;
    const email = (form.elements.namedItem('email') as HTMLInputElement).value;
    const password = (form.elements.namedItem('password') as HTMLInputElement).value;

    // Credentials プロバイダで認証 (リダイレクトはしない)
    const result = await signIn('credentials', {
      email,
      password,
      redirect: false,
    });

    // ローディング解除
    setLoading(false);

    if (result?.error) {
      // 認証失敗時: 共通の日本語エラー文言を表示
      setError('メールアドレスまたはパスワードが正しくありません');
    } else {
      // 成功時: 最新セッションを取得し、権限に応じた既定ページへ遷移
      const session = await getSession();
      router.push(isAgent(session?.user?.role) ? '/dashboard' : '/tickets');
    }
  }

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

        {/* ログインフォーム本体 */}
        <form onSubmit={handleSubmit} className="space-y-5">
          {/* メールアドレス入力 */}
          <div>
            <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-slate-700">
              メールアドレス
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              className="block w-full rounded-lg border border-slate-200 bg-slate-50/60 px-4 py-2.5 text-sm text-slate-900 transition placeholder:text-slate-400 focus:border-teal-500 focus:bg-white focus:ring-2 focus:ring-teal-500/30 focus:outline-none"
              placeholder="name@example.com"
            />
          </div>
          {/* パスワード入力 */}
          <div>
            <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-slate-700">
              パスワード
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="block w-full rounded-lg border border-slate-200 bg-slate-50/60 px-4 py-2.5 text-sm text-slate-900 transition placeholder:text-slate-400 focus:border-teal-500 focus:bg-white focus:ring-2 focus:ring-teal-500/30 focus:outline-none"
              placeholder="••••••••"
            />
          </div>
          {/* エラー文言 (ある場合のみ表示) ─ ロゼ枠で柔らかくアラート */}
          {error && (
            <p
              role="alert"
              className="rounded-lg bg-rose-50 px-3 py-2.5 text-sm text-rose-700 ring-1 ring-rose-200"
            >
              {error}
            </p>
          )}
          {/* 送信ボタン (ローディング中は無効化) */}
          <button
            type="submit"
            disabled={loading}
            aria-busy={loading}
            className="w-full rounded-lg bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-800 active:bg-teal-900 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? 'ログイン中...' : 'ログイン'}
          </button>
        </form>

        {/* フッター: サポート連絡先風の補足 (装飾) */}
        <p className="mt-6 text-center text-xs text-slate-400">
          ログインに関するお問い合わせは管理者までご連絡ください
        </p>
      </div>
    </div>
  );
}
