'use client';

import { useTransition } from 'react';
import { updateTicketPriority } from '@/features/tickets/actions/update-ticket';
import { PRIORITY_LABELS } from '@/lib/constants';
import type { Priority } from '@/generated/prisma';

const ALL_PRIORITIES: Priority[] = ['Low', 'Medium', 'High'];

interface Props {
  ticketId: string;
  current: Priority;
}

export function PrioritySelect({ ticketId, current }: Props) {
  const [isPending, startTransition] = useTransition();

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value as Priority;
    startTransition(() => updateTicketPriority(ticketId, next));
  }

  return (
    <select
      value={current}
      onChange={handleChange}
      disabled={isPending}
      className="rounded-md border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50"
    >
      {ALL_PRIORITIES.map((p) => (
        <option key={p} value={p}>{PRIORITY_LABELS[p] ?? p}</option>
      ))}
    </select>
  );
}
