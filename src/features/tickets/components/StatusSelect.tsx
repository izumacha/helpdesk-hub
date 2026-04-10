'use client';

import { useTransition } from 'react';
import { updateTicketStatus } from '@/features/tickets/actions/update-ticket';
import { STATUS_LABELS } from '@/lib/constants';
import { getAllowedTransitions } from '@/domain/ticket-status';
import type { TicketStatus } from '@/generated/prisma';

interface Props {
  ticketId: string;
  current: TicketStatus;
}

export function StatusSelect({ ticketId, current }: Props) {
  const [isPending, startTransition] = useTransition();
  const allowed = getAllowedTransitions(current);

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value as TicketStatus;
    startTransition(() => updateTicketStatus(ticketId, next));
  }

  if (allowed.length === 0) return null;

  return (
    <select
      value={current}
      onChange={handleChange}
      disabled={isPending}
      className="rounded-md border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50"
    >
      <option value={current} disabled>
        {STATUS_LABELS[current] ?? current}
      </option>
      {allowed.map((s) => (
        <option key={s} value={s}>
          {STATUS_LABELS[s] ?? s}
        </option>
      ))}
    </select>
  );
}
