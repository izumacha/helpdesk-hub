'use client';

import { useRef, useTransition, useState } from 'react';
import { escalateTicket } from '@/features/tickets/actions/update-ticket';

interface Props {
  ticketId: string;
}

export function EscalationForm({ ticketId }: Props) {
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const reason = ref.current?.value.trim() ?? '';
    if (!reason) return;

    setError(null);
    startTransition(async () => {
      try {
        await escalateTicket(ticketId, reason);
        setOpen(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'エラーが発生しました');
      }
    });
  }

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
    <form onSubmit={handleSubmit} className="mt-2 space-y-2">
      <textarea
        ref={ref}
        rows={2}
        required
        maxLength={1000}
        placeholder="エスカレーション理由を入力してください"
        className="block w-full rounded-md border border-gray-300 px-2 py-1.5 text-xs focus:border-red-500 focus:outline-none"
      />
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={isPending}
          className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
        >
          {isPending ? '処理中...' : '実行'}
        </button>
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
