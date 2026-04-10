'use client';

import { useRef, useTransition } from 'react';
import { addComment } from '@/features/tickets/actions/update-ticket';

interface Props {
  ticketId: string;
}

export function CommentForm({ ticketId }: Props) {
  const [isPending, startTransition] = useTransition();
  const ref = useRef<HTMLTextAreaElement>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const body = ref.current?.value.trim() ?? '';
    if (!body) return;

    startTransition(async () => {
      await addComment(ticketId, body);
      if (ref.current) ref.current.value = '';
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <textarea
        ref={ref}
        rows={3}
        required
        placeholder="コメントを入力してください"
        className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
      />
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
