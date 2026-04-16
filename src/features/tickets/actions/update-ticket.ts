'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { repos, uow } from '@/data';
import { broadcastUnreadCount, broadcastUnreadCountToMany } from '@/features/notifications/notify';
import { isAgent } from '@/lib/role';
import { isValidTransition } from '@/domain/ticket-status';
import type { Priority, TicketStatus } from '@/domain/types';
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

  await uow.run(async (r) => {
    const ticket = await r.tickets.findById(ticketId);
    if (!ticket) throw new Error('チケットが見つかりません');
    if (ticket.status === newStatus) return;
    if (!isValidTransition(ticket.status, newStatus)) {
      throw new Error(
        `ステータスを「${ticket.status}」から「${newStatus}」に変更することはできません`,
      );
    }

    await r.tickets.updateStatus(ticketId, newStatus);
    await r.history.record({
      ticketId,
      changedById: session.user.id,
      field: 'status',
      oldValue: ticket.status,
      newValue: newStatus,
    });
  });

  revalidatePath(`/tickets/${ticketId}`);
}

export async function updateTicketPriority(ticketId: string, newPriority: Priority) {
  const session = await auth();
  assertAgentRole(session);

  await uow.run(async (r) => {
    const ticket = await r.tickets.findById(ticketId);
    if (!ticket) throw new Error('チケットが見つかりません');
    if (ticket.priority === newPriority) return;

    await r.tickets.updatePriority(ticketId, newPriority);
    await r.history.record({
      ticketId,
      changedById: session.user.id,
      field: 'priority',
      oldValue: ticket.priority,
      newValue: newPriority,
    });
  });

  revalidatePath(`/tickets/${ticketId}`);
}

export async function updateTicketAssignee(ticketId: string, newAssigneeId: string | null) {
  const session = await auth();
  assertAgentRole(session);

  const [ticket, newUser] = await Promise.all([
    repos.tickets.findByIdWithRefs(ticketId),
    newAssigneeId ? repos.users.findById(newAssigneeId) : Promise.resolve(null),
  ]);

  if (!ticket) throw new Error('チケットが見つかりません');
  if (newAssigneeId && !newUser) throw new Error('担当者ユーザーが見つかりません');
  if (newUser && !isAgent(newUser.role)) {
    throw new Error('担当者にはエージェントまたは管理者のみ設定できます');
  }

  const oldName = ticket.assignee?.name ?? null;
  const newName = newUser?.name ?? null;

  await uow.run(async (r) => {
    await r.tickets.updateAssignee(ticketId, newAssigneeId);
    await r.history.record({
      ticketId,
      changedById: session.user.id,
      field: 'assignee',
      oldValue: oldName,
      newValue: newName,
    });
    if (newAssigneeId) {
      await r.notifications.create({
        userId: newAssigneeId,
        type: 'assigned',
        message: `チケット「${ticket.title}」の担当者に割り当てられました`,
        ticketId,
      });
    }
  });

  if (newAssigneeId) await broadcastUnreadCount(newAssigneeId);
  revalidatePath(`/tickets/${ticketId}`);
}

export async function escalateTicket(ticketId: string, reason: string) {
  const session = await auth();
  assertAgentRole(session);

  const [ticket, agentIds] = await Promise.all([
    repos.tickets.findById(ticketId),
    repos.users.listAgentIds(),
  ]);

  if (!ticket) throw new Error('チケットが見つかりません');
  if (!isValidTransition(ticket.status, 'Escalated')) {
    throw new Error(`現在のステータス「${ticket.status}」からエスカレーションできません`);
  }

  const now = new Date();
  const trimmedReason = reason.trim();
  const { title } = ticket;

  await uow.run(async (r) => {
    await r.tickets.markEscalated(ticketId, { reason: trimmedReason, at: now });
    await r.history.record({
      ticketId,
      changedById: session.user.id,
      field: 'escalation',
      oldValue: ticket.status,
      newValue: 'Escalated',
    });
    await Promise.all(
      agentIds.map((id) =>
        r.notifications.create({
          userId: id,
          type: 'escalated',
          message: `チケット「${title}」がエスカレーションされました`,
          ticketId,
        }),
      ),
    );
  });

  await broadcastUnreadCountToMany(agentIds);
  revalidatePath(`/tickets/${ticketId}`);
}

export async function addComment(ticketId: string, body: string) {
  const session = await auth();
  assertAuthenticatedUser(session);
  if (!body.trim()) throw new Error('コメントを入力してください');

  const ticket = await repos.tickets.findById(ticketId);
  if (!ticket) throw new Error('チケットが見つかりません');

  const canComment = isAgent(session.user.role) || ticket.creatorId === session.user.id;
  if (!canComment) {
    throw new Error('このチケットへのコメント権限がありません');
  }

  await repos.comments.create({
    ticketId,
    authorId: session.user.id,
    body: body.trim(),
  });
  revalidatePath(`/tickets/${ticketId}`);
}
