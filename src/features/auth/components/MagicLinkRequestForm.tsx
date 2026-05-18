'use client';

// React フック (フォーム状態の管理)
import { useState } from 'react';
// マジックリンク発行用の Server Action
import { requestMagicLink } from '@/features/auth/actions/request-magic-link';

// 「メールでログイン」タブの中身。フォーム送信後は同じカード内で確認メッセージに切り替える
export function MagicLinkRequestForm() {
  // 入力中のメールアドレス
  const [email, setEmail] = useState('');
  // エラー文言 (送信失敗時に表示)
  const [error, setError] = useState('');
  // 送信中フラグ (連打防止)
  const [loading, setLoading] = useState(false);
  // 送信完了フラグ (true なら確認画面を表示)
  const [submitted, setSubmitted] = useState(false);

  // フォーム送信ハンドラ
  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    // ブラウザの既定遷移を抑止
    e.preventDefault();
    // 直前のエラー表示を消す
    setError('');
    // ローディング表示開始
    setLoading(true);
    try {
      // Server Action を呼ぶ。常に { ok: true } が返る (未登録メールでも投げない)
      await requestMagicLink({ email });
      // 確認画面に切り替える
      setSubmitted(true);
    } catch (e) {
      // Zod の入力検証エラー等は Error として上がってくる
      setError(e instanceof Error ? e.message : 'メール送信に失敗しました');
    } finally {
      // ローディング解除
      setLoading(false);
    }
  }

  // 送信完了後は確認メッセージのみを表示する
  if (submitted) {
    return (
      <div role="status" className="space-y-3 text-center">
        {/* 主要メッセージ */}
        <p className="text-base font-semibold text-slate-900">メールを確認してください</p>
        {/* 補助メッセージ (どのメールを確認するかを明示) */}
        <p className="text-sm text-slate-600">
          <span className="font-medium text-slate-800">{email}</span> 宛にログイン用のリンクをお送りしました。
          <br />
          メール内のリンクをクリックするとログインが完了します。
        </p>
        <p className="text-xs text-slate-500">リンクの有効期限は約 15 分です。</p>
        {/* もう一度送り直すボタン (確認画面から戻る) */}
        <button
          type="button"
          onClick={() => {
            // 確認画面を閉じてフォームに戻る
            setSubmitted(false);
            setEmail('');
          }}
          className="text-sm font-medium text-teal-700 underline-offset-2 hover:underline"
        >
          別のメールアドレスで送り直す
        </button>
      </div>
    );
  }

  // 通常のフォーム表示
  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* 簡単な説明 */}
      <p className="text-sm text-slate-600">
        登録済みのメールアドレスを入力すると、ログイン用のリンクをお送りします。
      </p>
      {/* メールアドレス入力 */}
      <div>
        <label
          htmlFor="magic-email"
          className="mb-1.5 block text-sm font-medium text-slate-700"
        >
          メールアドレス
        </label>
        <input
          id="magic-email"
          name="email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="block w-full rounded-lg border border-slate-200 bg-slate-50/60 px-4 py-2.5 text-sm text-slate-900 transition placeholder:text-slate-400 focus:border-teal-500 focus:bg-white focus:ring-2 focus:ring-teal-500/30 focus:outline-none"
          placeholder="name@example.com"
        />
      </div>
      {/* エラー表示 */}
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
        {loading ? '送信中...' : 'ログインリンクを送る'}
      </button>
    </form>
  );
}
