'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { recordHistory } from '@/lib/ticket-history';
import type { TicketStatus, Priority } from '@/generated/prisma';

// ── Status ──────────────────────────────────────────────────────────────────

export async function updateTicketStatus(ticketId: string, newStatus: TicketStatus) {
  const session = await auth();
  if (!session?.user?.id) throw new Error('Unauthorized');

  const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
  if (ticket.status === newStatus) return;

  await prisma.ticket.update({ where: { id: ticketId }, data: { status: newStatus } });
  await recordHistory(ticketId, session.user.id, 'status', ticket.status, newStatus);
  revalidatePath(`/tickets/${ticketId}`);
}

// ── Priority ─────────────────────────────────────────────────────────────────

export async function updateTicketPriority(ticketId: string, newPriority: Priority) {
  const session = await auth();
  if (!session?.user?.id) throw new Error('Unauthorized');

  const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
  if (ticket.priority === newPriority) return;

  await prisma.ticket.update({ where: { id: ticketId }, data: { priority: newPriority } });
  await recordHistory(ticketId, session.user.id, 'priority', ticket.priority, newPriority);
  revalidatePath(`/tickets/${ticketId}`);
}

// ── Assignee ─────────────────────────────────────────────────────────────────

export async function updateTicketAssignee(ticketId: string, newAssigneeId: string | null) {
  const session = await auth();
  if (!session?.user?.id) throw new Error('Unauthorized');

  const ticket = await prisma.ticket.findUniqueOrThrow({
    where: { id: ticketId },
    include: { assignee: { select: { name: true } } },
  });

  const oldName = ticket.assignee?.name ?? null;
  let newName: string | null = null;
  if (newAssigneeId) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: newAssigneeId } });
    newName = user.name;
  }

  await prisma.ticket.update({
    where: { id: ticketId },
    data: { assigneeId: newAssigneeId },
  });
  await recordHistory(ticketId, session.user.id, 'assignee', oldName, newName);
  revalidatePath(`/tickets/${ticketId}`);
}

// ── Comment ───────────────────────────────────────────────────────────────────

export async function addComment(ticketId: string, body: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error('Unauthorized');
  if (!body.trim()) throw new Error('コメントを入力してください');

  await prisma.ticketComment.create({
    data: { ticketId, authorId: session.user.id, body: body.trim() },
  });
  revalidatePath(`/tickets/${ticketId}`);
}
