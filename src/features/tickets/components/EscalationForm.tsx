'use client';

// React フック (refs/トランジション/ローカル状態)
import { useRef, useTransition, useState } from 'react';
// エスカレーション用サーバーアクション
import { escalateTicket } from '@/features/tickets/actions/update-ticket';

// 受け取る props (対象チケット ID)
interface Props {
  ticketId: string;
}

// チケット詳細サイドバーのエスカレーション操作 (理由付き)
export function EscalationForm({ ticketId }: Props) {
  // 送信中フラグ + トランジション
  const [isPending, startTransition] = useTransition();
  // フォームを開いているか (false ならボタンのみ表示)
  const [open, setOpen] = useState(false);
  // サーバーから返ったエラー文言
  const [error, setError] = useState<string | null>(null);
  // 理由テキストエリアの参照
  const ref = useRef<HTMLTextAreaElement>(null);

  // 送信ハンドラ
  function handleSubmit(e: React.FormEvent) {
    // 既定遷移を抑止
    e.preventDefault();
    // 理由を trim
    const reason = ref.current?.value.trim() ?? '';
    // 空理由はブロック
    if (!reason) return;

    // エラー表示をリセット
    setError(null);
    // 非ブロッキングでサーバーアクション呼び出し
    startTransition(async () => {
      try {
        await escalateTicket(ticketId, reason);
        // 成功時はフォームを閉じる
        setOpen(false);
      } catch (err) {
        // 失敗時はエラー表示
        setError(err instanceof Error ? err.message : 'エラーが発生しました');
      }
    });
  }

  // 折りたたみ時はボタンのみ表示
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-2 rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700"
      >
        エスカレーション
      </button>
    );
  }

  return (
    // 展開後のフォーム (理由入力 + 実行/キャンセル)
    <form onSubmit={handleSubmit} className="mt-2 space-y-2">
      {/* 理由テキストエリア */}
      <textarea
        ref={ref}
        rows={2}
        required
        maxLength={1000}
        placeholder="エスカレーション理由を入力してください"
        className="block w-full rounded-md border border-gray-300 px-2 py-1.5 text-xs focus:border-red-500 focus:outline-none"
      />
      {/* エラー表示 */}
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex gap-2">
        {/* 実行ボタン (赤系) */}
        <button
          type="submit"
          disabled={isPending}
          className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
        >
          {isPending ? '処理中...' : '実行'}
        </button>
        {/* キャンセル */}
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
        >
          キャンセル
        </button>
      </div>
    </form>
  );
}
