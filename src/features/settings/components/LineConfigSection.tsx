'use client';

// Phase 2 フォローアップ: テナント単位の LINE 公式アカウント連携設定セクション
// (Pro / Enterprise プランの管理者向け)。docs/smb-dx-pivot-plan.md §4 Phase 2.1。
// LINE Developers コンソールで確認できる値を入力して保存する。

// React の Server Action 状態管理フックと送信中フラグ管理フック
import { useActionState, useTransition } from 'react';
// LINE 連携設定の作成/更新・削除サーバーアクション
import { updateLineConfig } from '@/features/settings/actions/update-line-config';
import { deleteLineConfig } from '@/features/settings/actions/delete-line-config';

// 現在の LINE 連携設定の「安全に表示できる部分」だけを受け取る (未設定なら null)。
// channelSecret / channelAccessToken は秘密情報のため §9 に従いフロントへ渡さない
// (書き込み専用: 空欄で保存すると既存値を維持する。update-line-config.ts 参照)。
// botUserId は秘密情報ではないので現在値をそのまま表示・再編集できる。
interface LineConfigView {
  botUserId: string; // このチャネルの Bot User ID
}

// Webhook 受信 URL (LINE Developers コンソールに登録する値。秘密情報ではない)
interface Props {
  config: LineConfigView | null; // 現在の LINE 連携設定 (botUserId のみ)
  webhookUrl: string; // Webhook 受信 URL
  planAllowed: boolean; // 現在のプランが LINE 連携を許可するか (false ならプラン降格後で削除のみ可能)
}

// 入力フィールド共通の Tailwind クラス
const fieldClass =
  'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500';
// ラベル共通の Tailwind クラス
const labelClass = 'block text-sm font-medium text-slate-700';
// 補足説明共通の Tailwind クラス
const helpClass = 'mt-1 text-xs text-slate-500';

// LINE 連携設定セクション本体
export function LineConfigSection({ config, webhookUrl, planAllowed }: Props) {
  // 設定保存アクションの状態
  const [saveState, saveAction] = useActionState(updateLineConfig, {});
  // 設定削除アクションの状態
  const [deleteState, deleteAction] = useActionState(deleteLineConfig, {});
  // 送信中フラグ (保存・削除で共有)
  const [isPending, startTransition] = useTransition();

  // 保存フォーム送信ハンドラ
  function handleSave(e: React.FormEvent<HTMLFormElement>) {
    // ブラウザ既定の送信を抑止する
    e.preventDefault();
    // フォームデータを取り出してアクションに渡す
    const formData = new FormData(e.currentTarget);
    // トランジション内で実行して isPending を立てる
    startTransition(() => saveAction(formData));
  }

  // 削除ボタンハンドラ
  function handleDelete() {
    // 誤操作防止の確認 (削除すると LINE 取り込み・返信 push が無効になる)
    if (
      !window.confirm('LINE 連携設定を削除しますか？ LINE からの取り込みと返信が無効になります。')
    ) {
      return;
    }
    // 空の FormData でアクションを呼ぶ
    startTransition(() => deleteAction(new FormData()));
  }

  // プラン降格後 (現在のプランでは LINE 連携を利用できない) は、既存設定の削除だけを
  // 案内する簡易表示にする。再設定フォームを出すと「保存」時にサーバー側のプランゲートで
  // 弾かれてしまい紛らわしいため、削除ボタンのみ表示する
  if (!planAllowed) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          現在のプランでは LINE 連携をご利用いただけません。既存の設定を削除できます
          （再設定するにはプランのアップグレードが必要です）。
        </p>
        {/* 削除結果メッセージ */}
        {deleteState.error && (
          <p role="alert" className="text-sm text-rose-700">
            {deleteState.error}
          </p>
        )}
        {deleteState.success && (
          <p role="status" aria-live="polite" className="text-sm text-teal-700">
            LINE 連携設定を削除しました。
          </p>
        )}
        {/* 削除ボタン (設定が存在する場合のみ表示) */}
        {config && (
          <button
            type="button"
            onClick={handleDelete}
            disabled={isPending}
            className="rounded-lg px-4 py-2 text-sm font-medium text-rose-600 transition hover:bg-rose-50 disabled:opacity-50"
          >
            設定を削除
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── Webhook 受信 URL (LINE Developers 側に登録する値) ─────────── */}
      <div className="space-y-3 rounded-xl bg-slate-50/60 p-4 ring-1 ring-slate-200">
        <p className="text-sm font-semibold text-slate-700">
          LINE Developers に登録する Webhook URL
        </p>
        <p className={helpClass}>
          LINE Developers コンソールの Messaging API 設定画面で、この URL を Webhook URL
          として登録してください。
        </p>
        <p className="rounded bg-slate-50 px-2 py-1 font-mono text-xs break-all text-slate-700 ring-1 ring-slate-200">
          {webhookUrl}
        </p>
      </div>

      {/* ── チャネル情報の入力フォーム ───────────────────────────────── */}
      <form onSubmit={handleSave} className="space-y-4">
        {/* Bot User ID */}
        <div className="space-y-1">
          <label htmlFor="line-bot-user-id" className={labelClass}>
            Bot User ID
          </label>
          <p className={helpClass}>
            LINE Developers コンソールの「あなたのユーザー
            ID」欄に表示される値。受信メッセージの宛先確認に使います。
          </p>
          <input
            id="line-bot-user-id"
            name="botUserId"
            type="text"
            defaultValue={config?.botUserId ?? ''}
            placeholder="U0123456789abcdef0123456789abcdef"
            autoComplete="off"
            required
            className={`${fieldClass} font-mono`}
          />
        </div>

        {/* チャネルシークレット (書き込み専用: 現在値は表示しない。空欄保存で維持) */}
        <div className="space-y-1">
          <label htmlFor="line-channel-secret" className={labelClass}>
            チャネルシークレット
          </label>
          <p className={helpClass}>
            Webhook の署名検証に使う秘匿情報です。
            {config
              ? '設定済みのため画面には表示されません。変更する場合のみ新しい値を入力してください（空欄なら現在の値を維持します）。'
              : ''}
          </p>
          <input
            id="line-channel-secret"
            name="channelSecret"
            type="password"
            placeholder={config ? '変更する場合のみ入力' : 'チャネルシークレット'}
            autoComplete="off"
            required={!config}
            className={fieldClass}
          />
        </div>

        {/* チャネルアクセストークン (書き込み専用: 現在値は表示しない。空欄保存で維持) */}
        <div className="space-y-1">
          <label htmlFor="line-channel-access-token" className={labelClass}>
            チャネルアクセストークン
          </label>
          <p className={helpClass}>
            担当者の返信を LINE へ push する Messaging API の長期アクセストークンです。
            {config
              ? '設定済みのため画面には表示されません。変更する場合のみ新しい値を入力してください（空欄なら現在の値を維持します）。'
              : ''}
          </p>
          <input
            id="line-channel-access-token"
            name="channelAccessToken"
            type="password"
            placeholder={config ? '変更する場合のみ入力' : 'チャネルアクセストークン'}
            autoComplete="off"
            required={!config}
            className={fieldClass}
          />
        </div>

        {/* エラーメッセージ (保存) */}
        {saveState.error && (
          <p role="alert" className="text-sm text-rose-700">
            {saveState.error}
          </p>
        )}
        {/* 成功メッセージ (保存) */}
        {saveState.success && (
          <p role="status" aria-live="polite" className="text-sm text-teal-700">
            LINE 連携設定を保存しました。
          </p>
        )}
        {/* 削除結果メッセージ */}
        {deleteState.error && (
          <p role="alert" className="text-sm text-rose-700">
            {deleteState.error}
          </p>
        )}
        {deleteState.success && (
          <p role="status" aria-live="polite" className="text-sm text-teal-700">
            LINE 連携設定を削除しました。
          </p>
        )}

        {/* 操作ボタン群 */}
        <div className="flex flex-wrap items-center gap-3">
          {/* 保存ボタン */}
          <button
            type="submit"
            disabled={isPending}
            className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPending ? '保存中…' : 'LINE 連携設定を保存'}
          </button>
          {/* 削除ボタン (設定が存在する場合のみ表示) */}
          {config && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={isPending}
              className="rounded-lg px-4 py-2 text-sm font-medium text-rose-600 transition hover:bg-rose-50 disabled:opacity-50"
            >
              設定を削除
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
