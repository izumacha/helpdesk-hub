'use client';

import { useTransition } from 'react';
import { updateTicketStatus } from '@/features/tickets/actions/update-ticket';
import { STATUS_LABELS } from '@/lib/constants';
import type { TicketStatus } from '@/generated/prisma';

const ALL_STATUSES: TicketStatus[] = [
  'New', 'Open', 'WaitingForUser', 'InProgress', 'Escalated', 'Resolved', 'Closed',
];

interface Props {
  ticketId: string;
  current: TicketStatus;
}

export function StatusSelect({ ticketId, current }: Props) {
  const [isPending, startTransition] = useTransition();

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value as TicketStatus;
    startTransition(() => updateTicketStatus(ticketId, next));
  }

  return (
    <select
      value={current}
      onChange={handleChange}
      disabled={isPending}
      className="rounded-md border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50"
    >
      {ALL_STATUSES.map((s) => (
        <option key={s} value={s}>{STATUS_LABELS[s] ?? s}</option>
      ))}
    </select>
  );
}
