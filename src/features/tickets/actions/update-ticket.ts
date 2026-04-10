'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { recordHistory } from '@/lib/ticket-history';
import { createNotification } from '@/lib/notifications';
import { isValidTransition } from '@/domain/ticket-status';
import type { TicketStatus, Priority } from '@/generated/prisma';

// ── Status ──────────────────────────────────────────────────────────────────

export async function updateTicketStatus(ticketId: string, newStatus: TicketStatus) {
  const session = await auth();
  if (!session?.user?.id) throw new Error('Unauthorized');

  const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
  if (ticket.status === newStatus) return;
  if (!isValidTransition(ticket.status, newStatus)) {
    throw new Error(`ステータスを「${ticket.status}」から「${newStatus}」に変更することはできません`);
  }

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
    if (user.role !== 'agent' && user.role !== 'admin') {
      throw new Error('担当者にはエージェントまたは管理者のみ設定できます');
    }
    newName = user.name;
  }

  await prisma.ticket.update({
    where: { id: ticketId },
    data: { assigneeId: newAssigneeId },
  });
  await recordHistory(ticketId, session.user.id, 'assignee', oldName, newName);

  // Notify the newly assigned agent
  if (newAssigneeId) {
    await createNotification(
      newAssigneeId,
      'assigned',
      `チケット「${ticket.title}」の担当者に割り当てられました`,
      ticketId,
    );
  }

  revalidatePath(`/tickets/${ticketId}`);
}

// ── Escalation ───────────────────────────────────────────────────────────────

export async function escalateTicket(ticketId: string, reason: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error('Unauthorized');
  if (session.user.role !== 'agent' && session.user.role !== 'admin') {
    throw new Error('エスカレーション操作はエージェントまたは管理者のみ実行できます');
  }

  const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
  if (!isValidTransition(ticket.status, 'Escalated')) {
    throw new Error(`現在のステータス「${ticket.status}」からエスカレーションできません`);
  }

  const now = new Date();
  await prisma.ticket.update({
    where: { id: ticketId },
    data: { status: 'Escalated', escalatedAt: now, escalationReason: reason.trim() },
  });
  await recordHistory(ticketId, session.user.id, 'escalation', ticket.status, 'Escalated');

  // Notify all agents and admins
  const agents = await prisma.user.findMany({
    where: { role: { in: ['agent', 'admin'] } },
    select: { id: true },
  });
  await Promise.all(
    agents.map((a) =>
      createNotification(
        a.id,
        'escalated',
        `チケット「${ticket.title}」がエスカレーションされました`,
        ticketId,
      ),
    ),
  );

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
