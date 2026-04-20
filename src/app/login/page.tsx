'use client';

// クライアント側のサインイン関数とセッション再取得関数
import { signIn, getSession } from 'next-auth/react';
// ログイン後のページ遷移に使う
import { useRouter } from 'next/navigation';
// 入力状態 (エラー/ローディング) を持つための React フック
import { useState } from 'react';
// エージェント権限判定
import { isAgent } from '@/lib/role';

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
    // 画面中央にカードを表示するレイアウト
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      {/* ログインカード */}
      <div className="w-full max-w-md rounded-lg bg-white p-8 shadow">
        <h1 className="mb-6 text-2xl font-bold text-gray-900">HelpDesk Hub</h1>
        {/* ログインフォーム本体 */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* メールアドレス入力 */}
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-700">
              メールアドレス
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>
          {/* パスワード入力 */}
          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-700">
              パスワード
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>
          {/* エラー文言 (ある場合のみ表示) */}
          {error && <p className="text-sm text-red-600">{error}</p>}
          {/* 送信ボタン (ローディング中は無効化) */}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? 'ログイン中...' : 'ログイン'}
          </button>
        </form>
      </div>
    </div>
  );
}
