'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { isAgent } from '@/lib/role';
import { recordHistory } from '@/lib/ticket-history';
import { createNotification } from '@/lib/notifications';
import { isValidTransition } from '@/domain/ticket-status';
import type { TicketStatus, Priority } from '@/generated/prisma';
import type { Session } from 'next-auth';

function assertAuthenticatedUser(session: Session | null): asserts session is Session {
  if (!session?.user?.id) throw new Error('Unauthorized');
}

function assertAgentRole(session: Session | null): asserts session is Session {
  assertAuthenticatedUser(session);
  if (!isAgent(session.user.role)) {
    throw new Error('この操作はエージェントまたは管理者のみ実行できます');
  }
}

export async function updateTicketStatus(ticketId: string, newStatus: TicketStatus) {
  const session = await auth();
  assertAgentRole(session);

  const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
  if (ticket.status === newStatus) return;
  if (!isValidTransition(ticket.status, newStatus)) {
    throw new Error(`ステータスを「${ticket.status}」から「${newStatus}」に変更することはできません`);
  }

  await prisma.ticket.update({ where: { id: ticketId }, data: { status: newStatus } });
  await recordHistory(ticketId, session.user.id, 'status', ticket.status, newStatus);
  revalidatePath(`/tickets/${ticketId}`);
}

export async function updateTicketPriority(ticketId: string, newPriority: Priority) {
  const session = await auth();
  assertAgentRole(session);

  const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
  if (ticket.priority === newPriority) return;

  await prisma.ticket.update({ where: { id: ticketId }, data: { priority: newPriority } });
  await recordHistory(ticketId, session.user.id, 'priority', ticket.priority, newPriority);
  revalidatePath(`/tickets/${ticketId}`);
}

export async function updateTicketAssignee(ticketId: string, newAssigneeId: string | null) {
  const session = await auth();
  assertAgentRole(session);

  const [ticket, newUser] = await Promise.all([
    prisma.ticket.findUniqueOrThrow({
      where: { id: ticketId },
      include: { assignee: { select: { name: true } } },
    }),
    newAssigneeId
      ? prisma.user.findUniqueOrThrow({ where: { id: newAssigneeId } })
      : Promise.resolve(null),
  ]);

  if (newUser && !isAgent(newUser.role)) {
    throw new Error('担当者にはエージェントまたは管理者のみ設定できます');
  }

  const oldName = ticket.assignee?.name ?? null;
  const newName = newUser?.name ?? null;

  await prisma.ticket.update({
    where: { id: ticketId },
    data: { assigneeId: newAssigneeId },
  });
  await recordHistory(ticketId, session.user.id, 'assignee', oldName, newName);

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

export async function escalateTicket(ticketId: string, reason: string) {
  const session = await auth();
  assertAgentRole(session);

  const [ticket, agents] = await Promise.all([
    prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } }),
    prisma.user.findMany({
      where: { role: { in: ['agent', 'admin'] } },
      select: { id: true },
    }),
  ]);

  if (!isValidTransition(ticket.status, 'Escalated')) {
    throw new Error(`現在のステータス「${ticket.status}」からエスカレーションできません`);
  }

  const now = new Date();
  await Promise.all([
    prisma.ticket.update({
      where: { id: ticketId },
      data: { status: 'Escalated', escalatedAt: now, escalationReason: reason.trim() },
    }),
    recordHistory(ticketId, session.user.id, 'escalation', ticket.status, 'Escalated'),
    ...agents.map((a) =>
      createNotification(
        a.id,
        'escalated',
        `チケット「${ticket.title}」がエスカレーションされました`,
        ticketId,
      ),
    ),
  ]);

  revalidatePath(`/tickets/${ticketId}`);
}

export async function addComment(ticketId: string, body: string) {
  const session = await auth();
  assertAuthenticatedUser(session);
  if (!body.trim()) throw new Error('コメントを入力してください');

  const ticket = await prisma.ticket.findUniqueOrThrow({
    where: { id: ticketId },
    select: { creatorId: true },
  });

  const canComment = isAgent(session.user.role) || ticket.creatorId === session.user.id;
  if (!canComment) {
    throw new Error('このチケットへのコメント権限がありません');
  }

  await prisma.ticketComment.create({
    data: { ticketId, authorId: session.user.id, body: body.trim() },
  });
  revalidatePath(`/tickets/${ticketId}`);
}
