'use client';

import { useTransition } from 'react';
import { updateTicketAssignee } from '@/features/tickets/actions/update-ticket';

type Agent = { id: string; name: string };

interface Props {
  ticketId: string;
  currentAssigneeId: string | null;
  agents: Agent[];
}

export function AssigneeSelect({ ticketId, currentAssigneeId, agents }: Props) {
  const [isPending, startTransition] = useTransition();

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const val = e.target.value;
    startTransition(() => updateTicketAssignee(ticketId, val || null));
  }

  return (
    <select
      value={currentAssigneeId ?? ''}
      onChange={handleChange}
      disabled={isPending}
      className="rounded-md border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50"
    >
      <option value="">未割当</option>
      {agents.map((a) => (
        <option key={a.id} value={a.id}>{a.name}</option>
      ))}
    </select>
  );
}
