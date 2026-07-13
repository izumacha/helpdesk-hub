'use client';

// クライアント側のサインイン関数 (作成直後の自動ログイン用)
import { signIn } from 'next-auth/react';
// ログイン後のページ遷移に使う
import { useRouter } from 'next/navigation';
// 入力状態 (エラー/ローディング) を持つための React フック
import { useState } from 'react';
// サインアップ完了サーバーアクション
import { completeSignup } from '@/features/auth/actions/complete-signup';
// パスワード最小長の単一参照元 (サーバー検証スキーマと共有)
import { PASSWORD_MIN_LENGTH } from '@/lib/validations/invite';
// 業種テンプレート一覧 (ドロップダウンの選択肢として使う / 純粋データなので Client Component でも安全)
import { INDUSTRY_TEMPLATES } from '@/lib/industry-templates';

// 受け取る props (サインアップ完了対象トークン)
interface Props {
  token: string; // 完了ページの URL から渡る生トークン
}

// サインアップ完了フォーム。組織名・業種・初代管理者の氏名・パスワードを設定してテナントを
// 作成し、自動ログインする (AcceptInviteForm と同じ「作成 → signIn → 権限に応じて遷移」の流れ。
// 作成される初代管理者は常に admin 権限なので、遷移先は常に /dashboard)
export function CompleteSignupForm({ token }: Props) {
  // クライアント側のページ遷移用ルーター
  const router = useRouter();
  // エラー文言 (完了失敗時に表示)
  const [error, setError] = useState('');
  // 送信中フラグ (連打防止 + ボタン文言切替)
  const [loading, setLoading] = useState(false);

  // フォーム送信時のハンドラ (完了 → 自動ログイン)
  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    // ブラウザ既定のページ遷移を抑止
    e.preventDefault();
    // 直前のエラー表示を消す
    setError('');
    // ローディング表示開始
    setLoading(true);

    // フォーム要素を取得
    const form = e.currentTarget;
    // 送信する FormData を組み立てる (tenantName / industry / adminName / adminPassword)
    const formData = new FormData(form);
    // 入力したパスワードは自動ログインで再利用するため控えておく
    const password = (form.elements.namedItem('adminPassword') as HTMLInputElement).value;

    try {
      // サインアップを完了してテナント + 初代管理者を作成する (失敗時は throw される)
      const { email } = await completeSignup(token, formData);
      // 作成したメール + 設定したパスワードでそのままログインする (redirect はせず結果を見る)
      const result = await signIn('credentials', { email, password, redirect: false });
      // ローディング解除
      setLoading(false);
      if (result?.error) {
        // 作成はできたがログインに失敗した稀なケース: ログイン画面へ案内する
        setError(
          '組織を作成しましたが、自動ログインに失敗しました。ログイン画面からお試しください。',
        );
        return;
      }
      // 作成される初代管理者は常に admin 権限なのでダッシュボードへ遷移する
      router.push('/dashboard');
    } catch (err) {
      // ローディング解除
      setLoading(false);
      // サーバーアクションの日本語エラーメッセージを表示
      setError(err instanceof Error ? err.message : 'サインアップの完了に失敗しました');
    }
  }

  return (
    // フォーム本体
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* 組織名 */}
      <div>
        <label htmlFor="tenantName" className="mb-1.5 block text-sm font-medium text-slate-700">
          組織名
        </label>
        <input
          id="tenantName"
          name="tenantName"
          type="text"
          required
          className="block w-full rounded-lg border border-slate-200 bg-slate-50/60 px-4 py-2.5 text-sm text-slate-900 transition placeholder:text-slate-400 focus:border-teal-500 focus:bg-white focus:ring-2 focus:ring-teal-500/30 focus:outline-none"
          placeholder="株式会社サンプル"
        />
      </div>

      {/* 業種 (任意): ドロップダウン選択肢は INDUSTRY_TEMPLATES から生成する (一元管理) */}
      <div>
        <label htmlFor="industry" className="mb-1.5 block text-sm font-medium text-slate-700">
          業種（任意）
        </label>
        {/* select 要素にすることで選択肢を限定し、自由入力による意図しない値を防ぐ */}
        <select
          id="industry"
          name="industry"
          className="block w-full rounded-lg border border-slate-200 bg-slate-50/60 px-4 py-2.5 text-sm text-slate-900 transition focus:border-teal-500 focus:bg-white focus:ring-2 focus:ring-teal-500/30 focus:outline-none"
        >
          {/* 未選択を表す既定オプション (空文字を送信するとサーバー側で undefined 扱い) */}
          <option value="">（なし）</option>
          {/* INDUSTRY_TEMPLATES を展開して各業種を選択肢として列挙する */}
          {INDUSTRY_TEMPLATES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      {/* 初代管理者氏名 */}
      <div>
        <label htmlFor="adminName" className="mb-1.5 block text-sm font-medium text-slate-700">
          お名前
        </label>
        <input
          id="adminName"
          name="adminName"
          type="text"
          required
          autoComplete="name"
          className="block w-full rounded-lg border border-slate-200 bg-slate-50/60 px-4 py-2.5 text-sm text-slate-900 transition placeholder:text-slate-400 focus:border-teal-500 focus:bg-white focus:ring-2 focus:ring-teal-500/30 focus:outline-none"
          placeholder="山田 太郎"
        />
      </div>

      {/* 初代管理者パスワード */}
      <div>
        <label htmlFor="adminPassword" className="mb-1.5 block text-sm font-medium text-slate-700">
          パスワード（{PASSWORD_MIN_LENGTH}文字以上）
        </label>
        <input
          id="adminPassword"
          name="adminPassword"
          type="password"
          required
          minLength={PASSWORD_MIN_LENGTH}
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
        {loading ? '作成中...' : '組織を作成して利用を開始する'}
      </button>
    </form>
  );
}
