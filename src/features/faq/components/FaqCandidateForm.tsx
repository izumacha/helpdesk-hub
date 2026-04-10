'use client';

import { useRef, useTransition, useState } from 'react';
import { createFaqCandidate } from '@/features/faq/actions/faq-actions';

interface Props {
  ticketId: string;
  ticketTitle: string;
}

export function FaqCandidateForm({ ticketId, ticketTitle }: Props) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const answerRef = useRef<HTMLTextAreaElement>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const q = questionRef.current?.value.trim() ?? '';
    const a = answerRef.current?.value.trim() ?? '';
    if (!q || !a) return;

    startTransition(async () => {
      await createFaqCandidate(ticketId, q, a);
      setOpen(false);
    });
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-2 rounded-md border border-blue-500 px-3 py-1.5 text-xs font-medium text-blue-600 hover:bg-blue-50"
      >
        FAQ候補に登録
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mt-2 space-y-2">
      <div>
        <label className="block text-xs font-medium text-gray-600">質問</label>
        <textarea
          ref={questionRef}
          rows={2}
          required
          defaultValue={ticketTitle}
          className="block w-full rounded-md border border-gray-300 px-2 py-1.5 text-xs focus:border-blue-500 focus:outline-none"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-600">回答</label>
        <textarea
          ref={answerRef}
          rows={3}
          required
          placeholder="解決方法を入力してください"
          className="block w-full rounded-md border border-gray-300 px-2 py-1.5 text-xs focus:border-blue-500 focus:outline-none"
        />
      </div>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={isPending}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {isPending ? '登録中...' : '登録'}
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
