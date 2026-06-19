'use client';

// 状態管理・非ブロッキング送信のためのフック
import { useState, useTransition } from 'react';
// 招待リンク発行のサーバーアクション
import { createInvitation } from '@/features/settings/actions/create-invitation';
// 招待可能な権限の一覧と、その日本語ラベル (一元管理された定数)
import { INVITABLE_ROLES, ROLE_LABELS } from '@/lib/constants';
// 権限型 (requester | agent | admin)
import type { Role } from '@/domain/types';

// メンバー招待リンクを発行するフォーム (権限選択 + 任意メール + リンク表示)
export function InviteForm() {
  // 送信中フラグ + トランジション (二重送信防止・ボタン無効化に使う)
  const [isPending, startTransition] = useTransition();
  // 選択中の権限 (初期値はメンバー = requester)
  const [role, setRole] = useState<Role>('requester');
  // 宛先メール (任意。空ならリンク手渡し)
  const [email, setEmail] = useState('');
  // 発行に成功した招待リンクの URL (未発行なら null)
  const [issuedUrl, setIssuedUrl] = useState<string | null>(null);
  // 「コピーしました」表示のフラグ
  const [copied, setCopied] = useState(false);
  // エラーメッセージ (サーバーアクションが throw した日本語メッセージ)
  const [error, setError] = useState<string | null>(null);

  // フォーム送信ハンドラ (既定の遷移を止めてアクションを呼ぶ)
  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    // ブラウザ既定の送信 (フルリロード) を抑止する
    e.preventDefault();
    // 直近のメッセージをリセット
    setError(null);
    setCopied(false);
    // 送信する FormData を組み立てる (role / email)
    const formData = new FormData();
    formData.set('role', role);
    formData.set('email', email);
    // トランジション内でサーバーアクションを実行
    startTransition(async () => {
      try {
        // 招待リンクを発行 (失敗時は throw されるので catch で拾う)
        const result = await createInvitation(formData);
        // 発行された URL を保持して画面に表示する
        setIssuedUrl(result.url);
      } catch (err) {
        // サーバーアクションの日本語エラーメッセージを表示
        setError(err instanceof Error ? err.message : '招待リンクの発行に失敗しました');
      }
    });
  }

  // 発行された URL をクリップボードにコピーするハンドラ
  async function handleCopy() {
    // 発行済み URL が無ければ何もしない
    if (!issuedUrl) return;
    try {
      // Clipboard API でコピー (HTTPS / localhost で利用可能)
      await navigator.clipboard.writeText(issuedUrl);
      // コピー成功表示を出す
      setCopied(true);
    } catch {
      // コピーに失敗してもエラーにはしない (URL はテキストとして選択可能なため)
      setCopied(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* 権限選択 (メンバー / 担当者) */}
      <fieldset className="space-y-2">
        {/* スクリーンリーダー向けにグループの目的を伝える凡例 */}
        <legend className="text-sm font-medium text-slate-700">招待する人の権限</legend>
        <div className="flex flex-wrap gap-3">
          {INVITABLE_ROLES.map((r) => {
            // この選択肢が現在選択中か
            const isChecked = role === r;
            return (
              <label
                key={r}
                // 選択中はティールで強調する
                className={`flex cursor-pointer items-center gap-2 rounded-lg border px-4 py-2 text-sm transition ${
                  isChecked
                    ? 'border-teal-400 bg-teal-50/60 ring-1 ring-teal-200'
                    : 'border-slate-200 bg-white hover:border-teal-200'
                }`}
              >
                {/* ラジオボタン本体 (name を揃えて単一選択にする) */}
                <input
                  type="radio"
                  name="role"
                  value={r}
                  checked={isChecked}
                  onChange={() => setRole(r)}
                  className="h-4 w-4 accent-teal-600"
                />
                {/* 権限ラベル (メンバー / 担当者) */}
                <span className="font-medium text-slate-800">{ROLE_LABELS[r]}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {/* 宛先メール (任意) */}
      <div className="space-y-1">
        {/* 入力に対応するラベル (a11y) */}
        <label htmlFor="invite-email" className="block text-sm font-medium text-slate-700">
          宛先メール（任意）
        </label>
        {/* 任意入力。指定すると案内メールも届く */}
        <input
          id="invite-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="member@example.com"
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-teal-400 focus:outline-none focus:ring-1 focus:ring-teal-200"
        />
        {/* 補足: メール未指定でもリンクは発行できる */}
        <p className="text-xs text-slate-500">
          メールを入力すると案内メールも送ります。空欄の場合は発行されたリンクを手渡しできます。
        </p>
      </div>

      {/* エラーメッセージ (色だけでなくテキストでも状態を伝える) */}
      {error && (
        <p className="text-sm text-rose-700" role="alert">
          {error}
        </p>
      )}

      {/* 発行ボタン */}
      <button
        type="submit"
        disabled={isPending}
        className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending ? '発行中…' : '招待リンクを発行する'}
      </button>

      {/* 発行された招待リンクの表示 (コピー可能) */}
      {issuedUrl && (
        // aria-live で発行結果をスクリーンリーダーに通知する
        <div className="space-y-2 rounded-xl border border-teal-200 bg-teal-50/60 p-4" aria-live="polite">
          {/* 見出し */}
          <p className="text-sm font-semibold text-teal-800">招待リンクを発行しました</p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            {/* 発行 URL (読み取り専用。選択してコピーもできる) */}
            <input
              type="text"
              readOnly
              value={issuedUrl}
              aria-label="発行された招待リンク"
              className="w-full flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-xs text-slate-700"
              onFocus={(e) => e.currentTarget.select()}
            />
            {/* コピーボタン */}
            <button
              type="button"
              onClick={handleCopy}
              className="shrink-0 rounded-lg border border-teal-300 bg-white px-3 py-2 text-sm font-medium text-teal-800 transition hover:bg-teal-50"
            >
              {copied ? 'コピーしました' : 'リンクをコピー'}
            </button>
          </div>
          {/* 補足: このリンクを共有すると相手が参加できる */}
          <p className="text-xs text-slate-500">
            このリンクを共有すると、相手はお名前とパスワードを設定して利用を開始できます。
          </p>
        </div>
      )}
    </form>
  );
}
