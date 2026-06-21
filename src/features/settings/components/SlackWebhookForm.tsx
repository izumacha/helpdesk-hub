'use client';

// React の useActionState フック (Server Action の状態管理)
import { useActionState } from 'react';
// 送信中フラグ管理フック
import { useTransition } from 'react';
// Slack Webhook URL を更新するサーバーアクション
import { updateSlackWebhookUrl } from '@/features/settings/actions/update-slack-webhook';

// フォームが受け取る props (現在設定済みの Webhook URL)
interface Props {
  // 現在の Slack/Teams Incoming Webhook URL (未設定なら null)
  current: string | null;
}

// Slack / Teams Incoming Webhook URL を設定・更新・削除するフォーム
// 空文字列で保存すると通知が無効化される (URL を削除する操作に相当)
export function SlackWebhookForm({ current }: Props) {
  // Server Action のレスポンス状態 (error / success) を管理する
  const [state, formAction] = useActionState(updateSlackWebhookUrl, {});
  // 送信中フラグ (ボタン二重押し防止と表示切替に使う)
  const [isPending, startTransition] = useTransition();

  // フォーム送信ハンドラ (useActionState の formAction を startTransition でラップして pending 制御)
  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    // ブラウザ既定の送信 (フルリロード) を抑止する
    e.preventDefault();
    // フォームデータを取り出してアクションに渡す
    const formData = new FormData(e.currentTarget);
    // トランジション内で実行することで isPending が true になる
    startTransition(() => formAction(formData));
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* URL 入力フィールドのラベルと説明 */}
      <div>
        <label htmlFor="slack-webhook-url" className="block text-sm font-medium text-slate-700">
          Incoming Webhook URL
        </label>
        <p className="mt-1 text-xs text-slate-500">
          Slack または Microsoft Teams の Incoming Webhook URL を入力してください。
          空欄で保存すると通知が無効になります。
        </p>
      </div>

      {/* URL テキスト入力 */}
      <input
        id="slack-webhook-url"
        name="slackWebhookUrl"
        type="url"
        // 現在の設定値を初期値として表示 (未設定なら空文字)
        defaultValue={current ?? ''}
        placeholder="https://hooks.slack.com/services/..."
        autoComplete="off"
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
        // aria-describedby でエラーメッセージと結びつける
        aria-describedby={state.error ? 'slack-webhook-error' : undefined}
        // aria-invalid でエラー状態を支援技術に伝える
        aria-invalid={!!state.error}
      />

      {/* エラーメッセージ (入力エラーまたは送信失敗) */}
      {state.error && (
        <p id="slack-webhook-error" role="alert" className="text-sm text-rose-700">
          {state.error}
        </p>
      )}

      {/* 成功メッセージ */}
      {state.success && (
        <p role="status" aria-live="polite" className="text-sm text-teal-700">
          Webhook URL を保存しました。
        </p>
      )}

      {/* 保存ボタン */}
      <button
        type="submit"
        disabled={isPending}
        className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending ? '保存中…' : '保存する'}
      </button>
    </form>
  );
}
