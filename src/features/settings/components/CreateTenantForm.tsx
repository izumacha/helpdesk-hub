'use client';

// 状態管理・非ブロッキング送信のためのフック
import { useState, useTransition } from 'react';
// テナント作成のサーバーアクション
import { createTenant } from '@/features/settings/actions/create-tenant';
// パスワード最小長の単一参照元 (サーバー検証スキーマと共有)
import { PASSWORD_MIN_LENGTH } from '@/lib/validations/invite';

// 新しい組織 (テナント) と初代管理者を作成するフォーム
export function CreateTenantForm() {
  // 送信中フラグ + トランジション (二重送信防止・ボタン無効化に使う)
  const [isPending, startTransition] = useTransition();
  // 作成成功時に表示する初代管理者メール (未作成なら null)
  const [createdEmail, setCreatedEmail] = useState<string | null>(null);
  // エラーメッセージ (サーバーアクションが throw した日本語メッセージ)
  const [error, setError] = useState<string | null>(null);

  // フォーム送信ハンドラ (既定の遷移を止めてアクションを呼ぶ)
  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    // ブラウザ既定の送信 (フルリロード) を抑止する
    e.preventDefault();
    // 直近のメッセージをリセット
    setError(null);
    setCreatedEmail(null);
    // フォーム内容を FormData にまとめる
    const formData = new FormData(e.currentTarget);
    // 送信成功後にフォームをクリアできるよう、要素参照を控える
    const form = e.currentTarget;
    // トランジション内でサーバーアクションを実行
    startTransition(async () => {
      try {
        // テナント + 初代管理者を作成する (失敗時は throw される)
        const result = await createTenant(formData);
        // 成功表示を出し、入力をクリアする
        setCreatedEmail(result.adminEmail);
        form.reset();
      } catch (err) {
        // サーバーアクションの日本語エラーメッセージを表示
        setError(err instanceof Error ? err.message : '組織の作成に失敗しました');
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* 組織名 */}
      <div className="space-y-1">
        <label htmlFor="tenantName" className="block text-sm font-medium text-slate-700">
          組織名
        </label>
        <input
          id="tenantName"
          name="tenantName"
          type="text"
          required
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-teal-400 focus:outline-none focus:ring-1 focus:ring-teal-200"
          placeholder="株式会社サンプル"
        />
      </div>

      {/* 業種 (任意) */}
      <div className="space-y-1">
        <label htmlFor="industry" className="block text-sm font-medium text-slate-700">
          業種（任意）
        </label>
        <input
          id="industry"
          name="industry"
          type="text"
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-teal-400 focus:outline-none focus:ring-1 focus:ring-teal-200"
          placeholder="製造業 / 飲食 / 介護 など"
        />
      </div>

      {/* 区切り見出し: 初代管理者 */}
      <fieldset className="space-y-4 border-t border-slate-100 pt-4">
        <legend className="text-sm font-semibold text-slate-800">初代管理者</legend>

        {/* 管理者氏名 */}
        <div className="space-y-1">
          <label htmlFor="adminName" className="block text-sm font-medium text-slate-700">
            お名前
          </label>
          <input
            id="adminName"
            name="adminName"
            type="text"
            required
            autoComplete="name"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-teal-400 focus:outline-none focus:ring-1 focus:ring-teal-200"
            placeholder="山田 太郎"
          />
        </div>

        {/* 管理者メール */}
        <div className="space-y-1">
          <label htmlFor="adminEmail" className="block text-sm font-medium text-slate-700">
            メールアドレス
          </label>
          <input
            id="adminEmail"
            name="adminEmail"
            type="email"
            required
            autoComplete="email"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-teal-400 focus:outline-none focus:ring-1 focus:ring-teal-200"
            placeholder="admin@example.com"
          />
        </div>

        {/* 管理者パスワード */}
        <div className="space-y-1">
          <label htmlFor="adminPassword" className="block text-sm font-medium text-slate-700">
            パスワード（{PASSWORD_MIN_LENGTH}文字以上）
          </label>
          <input
            id="adminPassword"
            name="adminPassword"
            type="password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            autoComplete="new-password"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-teal-400 focus:outline-none focus:ring-1 focus:ring-teal-200"
            placeholder="••••••••"
          />
        </div>
      </fieldset>

      {/* 成功メッセージ (aria-live でスクリーンリーダーに通知) */}
      {createdEmail && (
        <p className="text-sm text-teal-700" role="status" aria-live="polite">
          組織を作成しました。初代管理者（{createdEmail}）でログインできます。
        </p>
      )}
      {/* エラーメッセージ (色だけでなくテキストでも状態を伝える) */}
      {error && (
        <p className="text-sm text-rose-700" role="alert">
          {error}
        </p>
      )}

      {/* 作成ボタン */}
      <button
        type="submit"
        disabled={isPending}
        className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending ? '作成中…' : '組織を作成する'}
      </button>
    </form>
  );
}
