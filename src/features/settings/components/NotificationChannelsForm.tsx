'use client';

// React の Server Action 状態管理フックと送信中フラグ管理フック
import { useActionState, useTransition } from 'react';
// 外部通知チャネル設定を更新するサーバーアクション
import { updateNotificationChannels } from '@/features/settings/actions/update-notification-channels';

// フォームが受け取る props (現在設定済みの各チャネル値)
interface Props {
  slackWebhookUrl: string | null; // 現在の Slack Incoming Webhook URL (未設定なら null)
  teamsWebhookUrl: string | null; // 現在の Teams Incoming Webhook URL (未設定なら null)
  chatworkApiToken: string | null; // 現在の Chatwork API トークン (未設定なら null)
  chatworkRoomId: string | null; // 現在の Chatwork ルーム ID (未設定なら null)
}

// 入力フィールド共通の Tailwind クラス (見た目を一元管理する)
const fieldClass =
  'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500';
// ラベル共通の Tailwind クラス
const labelClass = 'block text-sm font-medium text-slate-700';
// 補足説明共通の Tailwind クラス
const helpClass = 'mt-1 text-xs text-slate-500';

// Slack / Teams / Chatwork の通知チャネル設定をまとめて編集するフォーム。
// 各フィールドを空欄で保存すると、そのチャネルの通知が無効になる。
export function NotificationChannelsForm({
  slackWebhookUrl,
  teamsWebhookUrl,
  chatworkApiToken,
  chatworkRoomId,
}: Props) {
  // Server Action のレスポンス状態 (error / success) を管理する
  const [state, formAction] = useActionState(updateNotificationChannels, {});
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
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* ── Slack ───────────────────────────────────────────── */}
      <div className="space-y-2">
        <label htmlFor="slack-webhook-url" className={labelClass}>
          Slack Incoming Webhook URL
        </label>
        <p className={helpClass}>
          Slack の Incoming Webhook URL を入力すると、その Slack チャンネルに通知が届きます。
        </p>
        <input
          id="slack-webhook-url"
          name="slackWebhookUrl"
          type="url"
          defaultValue={slackWebhookUrl ?? ''}
          placeholder="https://hooks.slack.com/services/..."
          autoComplete="off"
          className={fieldClass}
        />
      </div>

      {/* ── Microsoft Teams ─────────────────────────────────── */}
      <div className="space-y-2">
        <label htmlFor="teams-webhook-url" className={labelClass}>
          Microsoft Teams Incoming Webhook URL
        </label>
        <p className={helpClass}>
          Teams の Workflows / Incoming Webhook URL を入力すると、そのチームに通知が届きます。
        </p>
        <input
          id="teams-webhook-url"
          name="teamsWebhookUrl"
          type="url"
          defaultValue={teamsWebhookUrl ?? ''}
          placeholder="https://prod-00.japaneast.logic.azure.com/..."
          autoComplete="off"
          className={fieldClass}
        />
      </div>

      {/* ── Chatwork ────────────────────────────────────────── */}
      <div className="space-y-2">
        <span className={labelClass}>Chatwork</span>
        <p className={helpClass}>
          Chatwork の API トークンと投稿先のルーム ID（数字）を入力すると、
          そのルームに通知が届きます。両方の入力が必要です。
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="chatwork-api-token" className="sr-only">
              Chatwork API トークン
            </label>
            <input
              id="chatwork-api-token"
              name="chatworkApiToken"
              type="password"
              defaultValue={chatworkApiToken ?? ''}
              placeholder="API トークン"
              autoComplete="off"
              className={fieldClass}
            />
          </div>
          <div>
            <label htmlFor="chatwork-room-id" className="sr-only">
              Chatwork ルーム ID
            </label>
            <input
              id="chatwork-room-id"
              name="chatworkRoomId"
              type="text"
              inputMode="numeric"
              defaultValue={chatworkRoomId ?? ''}
              placeholder="ルーム ID（例: 12345678）"
              autoComplete="off"
              className={fieldClass}
            />
          </div>
        </div>
      </div>

      {/* エラーメッセージ (入力エラーまたは送信失敗) */}
      {state.error && (
        <p role="alert" className="text-sm text-rose-700">
          {state.error}
        </p>
      )}

      {/* 成功メッセージ */}
      {state.success && (
        <p role="status" aria-live="polite" className="text-sm text-teal-700">
          通知チャネルの設定を保存しました。
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
