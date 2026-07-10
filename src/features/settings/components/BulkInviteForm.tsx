'use client';

// §7.1 フォローアップ (2026-07-10): 複数メールアドレス (CSV アップロード or 貼り付け) から
// まとめて招待リンクを発行するフォーム。docs/smb-dx-pivot-plan.md §7.1 の「メンバーを招待
// （リンク貼り付け or CSV）」のうち、これまで存在しなかった「CSV」経路を実装する。
// InviteForm.tsx (1 件ずつの発行) とはタブで切り替える兄弟コンポーネント。

// 状態管理・非ブロッキング送信のためのフック
import { useRef, useState, useTransition } from 'react';
// 一括招待発行のサーバーアクション + 戻り値の型
import {
  createInvitationsBulk,
  type BulkInvitationRowResult,
} from '@/features/settings/actions/create-invitations-bulk';
// 招待可能な権限の一覧と、その日本語ラベル (InviteForm.tsx と共有する一元管理定数)
import { INVITABLE_ROLES, ROLE_LABELS } from '@/lib/constants';
// 一括招待 1 回あたりの上限件数 (画面の補足文言に使う)
import { MAX_BULK_INVITE_ROWS } from '@/lib/invite';
// 権限型 (requester | agent | admin)
import type { Role } from '@/domain/types';

// 複数メールアドレスをまとめて招待するフォーム (権限選択 + CSV/貼り付け + 結果一覧)
export function BulkInviteForm() {
  // 送信中フラグ + トランジション (二重送信防止・ボタン無効化に使う)
  const [isPending, startTransition] = useTransition();
  // 選択中の権限 (バッチ全体で共通。初期値はメンバー = requester)
  const [role, setRole] = useState<Role>('requester');
  // メールアドレス一覧のテキスト (1 行 1 件、または CSV の 1 列目)
  const [emailsText, setEmailsText] = useState('');
  // 発行結果 (行ごとの成功/失敗。未発行なら null)
  const [results, setResults] = useState<BulkInvitationRowResult[] | null>(null);
  // エラーメッセージ (サーバーアクションが throw した日本語メッセージ。行単位でなくバッチ全体の失敗)
  const [error, setError] = useState<string | null>(null);
  // ファイル選択 input への参照 (アップロード後に値をリセットするため)
  const fileInputRef = useRef<HTMLInputElement>(null);

  // CSV ファイルが選択されたら中身をテキストとして読み込み、貼り付けエリアに反映する
  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    // 選択されたファイル (キャンセル時は undefined)
    const file = e.target.files?.[0];
    if (!file) return;
    // ファイル内容をテキストとして読み込む (UTF-8 前提。Excel 由来の Shift_JIS は非対応)
    const text = await file.text();
    // 既存の貼り付け内容を上書きする (アップロード = 一覧全体の差し替えという直感的な挙動)
    setEmailsText(text);
    // 同じファイルを選び直しても onChange が発火するよう input の値をリセットする
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  // フォーム送信ハンドラ (既定の遷移を止めてアクションを呼ぶ)
  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    // ブラウザ既定の送信 (フルリロード) を抑止する
    e.preventDefault();
    // 直近のメッセージをリセット
    setError(null);
    setResults(null);
    // 送信する FormData を組み立てる (role / emails)
    const formData = new FormData();
    formData.set('role', role);
    formData.set('emails', emailsText);
    // トランジション内でサーバーアクションを実行
    startTransition(async () => {
      try {
        // 一括発行を実行 (バッチ全体の検証失敗時は throw されるので catch で拾う)
        const result = await createInvitationsBulk(formData);
        // 行ごとの結果を画面に表示する
        setResults(result.results);
      } catch (err) {
        // サーバーアクションの日本語エラーメッセージを表示
        setError(err instanceof Error ? err.message : '招待リンクの一括発行に失敗しました');
      }
    });
  }

  // 成功件数 (結果サマリー表示に使う)
  const successCount = results?.filter((r) => r.ok).length ?? 0;

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* 権限選択 (バッチ全体で共通の権限を付与する) */}
      <fieldset className="space-y-2">
        {/* スクリーンリーダー向けにグループの目的を伝える凡例 */}
        <legend className="text-sm font-medium text-slate-700">招待する人たちの権限</legend>
        <div className="flex flex-wrap gap-3">
          {INVITABLE_ROLES.map((r) => {
            // この選択肢が現在選択中か
            const isChecked = role === r;
            return (
              <label
                key={r}
                className={`flex cursor-pointer items-center gap-2 rounded-lg border px-4 py-2 text-sm transition ${
                  isChecked
                    ? 'border-teal-400 bg-teal-50/60 ring-1 ring-teal-200'
                    : 'border-slate-200 bg-white hover:border-teal-200'
                }`}
              >
                <input
                  type="radio"
                  name="bulk-role"
                  value={r}
                  checked={isChecked}
                  onChange={() => setRole(r)}
                  className="h-4 w-4 accent-teal-600"
                />
                <span className="font-medium text-slate-800">{ROLE_LABELS[r]}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {/* CSV ファイル選択 (任意。選ぶと下の貼り付けエリアに読み込まれる) */}
      <div className="space-y-1">
        <label htmlFor="bulk-invite-file" className="block text-sm font-medium text-slate-700">
          CSV ファイルを選択（任意）
        </label>
        <input
          id="bulk-invite-file"
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv,text/plain"
          onChange={handleFileChange}
          className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-teal-50 file:px-3 file:py-2 file:text-sm file:font-medium file:text-teal-800 hover:file:bg-teal-100"
        />
      </div>

      {/* メールアドレス貼り付けエリア (CSV アップロード結果もここに入る) */}
      <div className="space-y-1">
        <label htmlFor="bulk-invite-emails" className="block text-sm font-medium text-slate-700">
          メールアドレス（1 行に 1 件、または CSV の 1 列目）
        </label>
        <textarea
          id="bulk-invite-emails"
          value={emailsText}
          onChange={(e) => setEmailsText(e.target.value)}
          placeholder={'member1@example.com\nmember2@example.com'}
          rows={6}
          className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-xs focus:border-teal-400 focus:ring-1 focus:ring-teal-200 focus:outline-none"
        />
        {/* 補足: 上限件数と重複除去の挙動を伝える */}
        <p className="text-xs text-slate-500">
          一度に招待できるのは最大 {MAX_BULK_INVITE_ROWS}{' '}
          件までです。重複したメールアドレスは自動的にまとめられます。全員に案内メールが届きます。
        </p>
      </div>

      {/* バッチ全体のエラーメッセージ (色だけでなくテキストでも状態を伝える) */}
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
        {isPending ? '発行中…' : 'まとめて招待リンクを発行する'}
      </button>

      {/* 行ごとの発行結果一覧 (成功/失敗を明示する) */}
      {results && (
        // aria-live で発行結果をスクリーンリーダーに通知する
        <div
          className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-4"
          aria-live="polite"
        >
          {/* サマリー見出し */}
          <p className="text-sm font-semibold text-slate-800">
            {results.length} 件中 {successCount} 件を発行しました
          </p>
          {/* 行ごとの結果テーブル */}
          <ul className="space-y-1">
            {results.map((r) => (
              <li key={r.email} className="flex items-start gap-2 text-xs">
                {/* 成否は色だけでなくテキストでも伝える (§7 a11y) */}
                <span
                  className={`mt-0.5 shrink-0 rounded-full px-1.5 py-0.5 font-medium ${
                    r.ok ? 'bg-teal-100 text-teal-800' : 'bg-rose-100 text-rose-800'
                  }`}
                >
                  {r.ok ? '成功' : '失敗'}
                </span>
                <span className="text-slate-700">{r.email}</span>
                {/* 失敗理由 (シート上限到達など) */}
                {!r.ok && r.error && <span className="text-rose-600">{r.error}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </form>
  );
}
