'use client';

// クライアント側のサインイン関数とセッション再取得関数 (作成直後の自動ログイン用)
import { signIn, getSession } from 'next-auth/react';
// ログイン後のページ遷移に使う
import { useRouter } from 'next/navigation';
// 入力状態 (エラー/ローディング) を持つための React フック
import { useState } from 'react';
// 招待受諾サーバーアクション
import { acceptInvitation } from '@/features/auth/actions/accept-invitation';
// エージェント権限判定 (ログイン後の遷移先決定で利用)
import { isAgent } from '@/lib/role';

// 受け取る props (受諾対象トークンと、メール入力が必要か)
interface Props {
  token: string; // 受諾ページの URL から渡る生トークン
  needsEmail: boolean; // 招待にメールが無い場合は true (フォームでメールを尋ねる)
}

// 招待受諾フォーム。氏名・パスワード (必要ならメール) を設定してユーザーを作成し、自動ログインする
export function AcceptInviteForm({ token, needsEmail }: Props) {
  // クライアント側のページ遷移用ルーター
  const router = useRouter();
  // エラー文言 (受諾失敗時に表示)
  const [error, setError] = useState('');
  // 送信中フラグ (連打防止 + ボタン文言切替)
  const [loading, setLoading] = useState(false);

  // フォーム送信時のハンドラ (受諾 → 自動ログイン)
  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    // ブラウザ既定のページ遷移を抑止
    e.preventDefault();
    // 直前のエラー表示を消す
    setError('');
    // ローディング表示開始
    setLoading(true);

    // フォーム要素を取得
    const form = e.currentTarget;
    // 送信する FormData を組み立てる (name / password / email)
    const formData = new FormData(form);
    // 入力したパスワードは自動ログインで再利用するため控えておく
    const password = (form.elements.namedItem('password') as HTMLInputElement).value;

    try {
      // 招待を受諾してユーザーを作成する (失敗時は throw される)
      const { email } = await acceptInvitation(token, formData);
      // 作成したメール + 設定したパスワードでそのままログインする (redirect はせず結果を見る)
      const result = await signIn('credentials', { email, password, redirect: false });
      // ローディング解除
      setLoading(false);
      if (result?.error) {
        // 作成はできたがログインに失敗した稀なケース: ログイン画面へ案内する
        setError('アカウントを作成しましたが、自動ログインに失敗しました。ログイン画面からお試しください。');
        return;
      }
      // 成功時: 最新セッションを取得し、権限に応じた既定ページへ遷移
      const session = await getSession();
      router.push(isAgent(session?.user?.role) ? '/dashboard' : '/tickets');
    } catch (err) {
      // ローディング解除
      setLoading(false);
      // サーバーアクションの日本語エラーメッセージを表示
      setError(err instanceof Error ? err.message : '招待の受諾に失敗しました');
    }
  }

  return (
    // フォーム本体
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* 氏名入力 */}
      <div>
        <label htmlFor="name" className="mb-1.5 block text-sm font-medium text-slate-700">
          お名前
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required
          autoComplete="name"
          className="block w-full rounded-lg border border-slate-200 bg-slate-50/60 px-4 py-2.5 text-sm text-slate-900 transition placeholder:text-slate-400 focus:border-teal-500 focus:bg-white focus:ring-2 focus:ring-teal-500/30 focus:outline-none"
          placeholder="山田 太郎"
        />
      </div>

      {/* メール入力 (招待にメールが無い場合のみ表示) */}
      {needsEmail && (
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
      )}

      {/* パスワード入力 */}
      <div>
        <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-slate-700">
          パスワード（8文字以上）
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
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
        {loading ? '設定中...' : '参加して利用を開始する'}
      </button>
    </form>
  );
}
