'use client';

// クライアント側のサインイン関数とセッション再取得関数
import { signIn, getSession } from 'next-auth/react';
// ログイン後のページ遷移に使う
import { useRouter } from 'next/navigation';
// 入力状態 (エラー/ローディング) を持つための React フック
import { useState } from 'react';
// エージェント権限判定 (ログイン後の遷移先決定で利用)
import { isAgent } from '@/lib/role';

// パスワード経路のログインフォーム。LoginTabs から「パスワードでログイン」タブとして利用される
export function PasswordLoginForm({ initialError }: { initialError?: string }) {
  // クライアント側のページ遷移用ルーター
  const router = useRouter();
  // エラー文言 (ログイン失敗時に表示)。初期エラー (例: マジックリンク失敗で戻った直後) を反映
  const [error, setError] = useState(initialError ?? '');
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
    // フォーム本体
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
      {/* エラー文言 (ある場合のみ表示) */}
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
  );
}
