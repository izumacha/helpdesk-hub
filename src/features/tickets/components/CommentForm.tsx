'use client';

// テキストエリア参照 + トランジション
import { useRef, useTransition } from 'react';
// コメント追加サーバーアクション
import { addComment } from '@/features/tickets/actions/update-ticket';

// 受け取る props (どのチケットへのコメントか)
interface Props {
  ticketId: string;
}

// チケット詳細ページのコメント投稿フォーム
export function CommentForm({ ticketId }: Props) {
  // 送信中フラグ + トランジション関数
  const [isPending, startTransition] = useTransition();
  // テキストエリアへの参照 (送信後にクリアするため)
  const ref = useRef<HTMLTextAreaElement>(null);

  // 送信ハンドラ
  function handleSubmit(e: React.FormEvent) {
    // 既定遷移を抑止
    e.preventDefault();
    // 入力値を trim
    const body = ref.current?.value.trim() ?? '';
    // 空送信はブロック
    if (!body) return;

    // 非ブロッキング送信
    startTransition(async () => {
      // サーバーアクションでコメントを保存
      await addComment(ticketId, body);
      // 成功後にテキストエリアをクリア
      if (ref.current) ref.current.value = '';
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      {/* コメント本文 (最大 5000 文字) */}
      <textarea
        ref={ref}
        rows={3}
        required
        maxLength={5000}
        placeholder="コメントを入力してください"
        className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
      />
      {/* 送信ボタン (送信中は無効化 + 文言切替) */}
      <button
        type="submit"
        disabled={isPending}
        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {isPending ? '送信中...' : 'コメントを投稿'}
      </button>
    </form>
  );
}
