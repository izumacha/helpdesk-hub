import { prisma } from '@/lib/prisma';
import type { HistoryField } from '@/generated/prisma';

export async function recordHistory(
  ticketId: string,
  changedById: string,
  field: HistoryField,
  oldValue: string | null,
  newValue: string | null,
) {
  await prisma.ticketHistory.create({
    data: { ticketId, changedById, field, oldValue, newValue },
  });
}
