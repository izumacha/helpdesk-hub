import { notFound } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { STATUS_LABELS, STATUS_COLORS, PRIORITY_LABELS, PRIORITY_COLORS } from '@/lib/constants';
import { StatusSelect } from '@/features/tickets/components/StatusSelect';
import { PrioritySelect } from '@/features/tickets/components/PrioritySelect';
import { AssigneeSelect } from '@/features/tickets/components/AssigneeSelect';
import { CommentForm } from '@/features/tickets/components/CommentForm';
import { EscalationForm } from '@/features/tickets/components/EscalationForm';
import { getSlaState, SLA_LABELS, SLA_COLORS } from '@/lib/sla';
import { getAllowedTransitions } from '@/domain/ticket-status';

const HISTORY_FIELD_LABELS: Record<string, string> = {
  status: 'ステータス',
  priority: '優先度',
  assignee: '担当者',
  escalation: 'エスカレーション',
};

interface Props {
  params: Promise<{ id: string }>;
}

export default async function TicketDetailPage({ params }: Props) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) return null;

  const isAgent = session.user.role === 'agent' || session.user.role === 'admin';

  const [ticket, agents] = await Promise.all([
    prisma.ticket.findUnique({
      where: { id },
      include: {
        creator: { select: { id: true, name: true } },
        assignee: { select: { id: true, name: true } },
        category: { select: { id: true, name: true } },
        comments: {
          orderBy: { createdAt: 'asc' },
          include: { author: { select: { id: true, name: true } } },
        },
        histories: {
          orderBy: { createdAt: 'desc' },
          include: { changedBy: { select: { id: true, name: true } } },
        },
      },
    }),
    isAgent
      ? prisma.user.findMany({
          where: { role: { in: ['agent', 'admin'] } },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        })
      : Promise.resolve([]),
  ]);

  if (!ticket) notFound();

  // RBAC: requesters can only view their own tickets
  if (!isAgent && ticket.creatorId !== session.user.id) notFound();

  const slaState = getSlaState(ticket.resolutionDueAt, ticket.resolvedAt);
  const canEscalate = isAgent && getAllowedTransitions(ticket.status).includes('Escalated');

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* Title */}
      <div>
        <p className="text-sm text-gray-500">#{ticket.id.slice(0, 8)}</p>
        <h1 className="mt-1 text-2xl font-bold text-gray-900">{ticket.title}</h1>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Main content */}
        <div className="space-y-6 lg:col-span-2">
          {/* Body */}
          <section className="rounded-lg bg-white p-5 shadow-sm">
            <h2 className="mb-3 text-sm font-semibold text-gray-500">問い合わせ内容</h2>
            <p className="whitespace-pre-wrap text-sm text-gray-800">{ticket.body}</p>
          </section>

          {/* Comments */}
          <section className="rounded-lg bg-white p-5 shadow-sm">
            <h2 className="mb-4 text-sm font-semibold text-gray-500">
              コメント（{ticket.comments.length}件）
            </h2>

            {ticket.comments.length === 0 ? (
              <p className="mb-4 text-sm text-gray-400">まだコメントはありません</p>
            ) : (
              <ul className="mb-4 space-y-4">
                {ticket.comments.map((c) => (
                  <li key={c.id} className="border-l-2 border-gray-200 pl-4">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-700">{c.author.name}</span>
                      <span className="text-xs text-gray-400">
                        {c.createdAt.toLocaleString('ja-JP')}
                      </span>
                    </div>
                    <p className="whitespace-pre-wrap text-sm text-gray-700">{c.body}</p>
                  </li>
                ))}
              </ul>
            )}

            <CommentForm ticketId={ticket.id} />
          </section>

          {/* History */}
          <section className="rounded-lg bg-white p-5 shadow-sm">
            <h2 className="mb-4 text-sm font-semibold text-gray-500">変更履歴</h2>
            {ticket.histories.length === 0 ? (
              <p className="text-sm text-gray-400">変更履歴はありません</p>
            ) : (
              <ul className="space-y-2">
                {ticket.histories.map((h) => (
                  <li key={h.id} className="flex items-start gap-2 text-sm text-gray-600">
                    <span className="mt-0.5 text-xs text-gray-400">
                      {h.createdAt.toLocaleString('ja-JP')}
                    </span>
                    <span>
                      <span className="font-medium">{h.changedBy.name}</span> が{' '}
                      <span className="font-medium">
                        {HISTORY_FIELD_LABELS[h.field] ?? h.field}
                      </span>{' '}
                      を「{h.oldValue ?? '―'}」→「{h.newValue ?? '―'}」に変更
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* Sidebar */}
        <aside className="space-y-4">
          <div className="rounded-lg bg-white p-5 shadow-sm">
            <h2 className="mb-4 text-sm font-semibold text-gray-500">詳細</h2>

            <dl className="space-y-3 text-sm">
              {/* Status */}
              <div>
                <dt className="font-medium text-gray-500">ステータス</dt>
                <dd className="mt-1">
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[ticket.status] ?? ''}`}
                  >
                    {STATUS_LABELS[ticket.status] ?? ticket.status}
                  </span>
                  {isAgent && (
                    <div className="mt-1">
                      <StatusSelect ticketId={ticket.id} current={ticket.status} />
                    </div>
                  )}
                </dd>
              </div>

              {/* Priority */}
              <div>
                <dt className="font-medium text-gray-500">優先度</dt>
                <dd className="mt-1">
                  <span className={`text-sm ${PRIORITY_COLORS[ticket.priority] ?? ''}`}>
                    {PRIORITY_LABELS[ticket.priority] ?? ticket.priority}
                  </span>
                  {isAgent && (
                    <div className="mt-1">
                      <PrioritySelect ticketId={ticket.id} current={ticket.priority} />
                    </div>
                  )}
                </dd>
              </div>

              {/* Assignee */}
              <div>
                <dt className="font-medium text-gray-500">担当者</dt>
                <dd className="mt-1">
                  {isAgent ? (
                    <AssigneeSelect
                      ticketId={ticket.id}
                      currentAssigneeId={ticket.assigneeId}
                      agents={agents}
                    />
                  ) : (
                    <span className="text-gray-700">{ticket.assignee?.name ?? '未割当'}</span>
                  )}
                </dd>
              </div>

              {/* Category */}
              <div>
                <dt className="font-medium text-gray-500">カテゴリ</dt>
                <dd className="mt-1 text-gray-700">{ticket.category?.name ?? '―'}</dd>
              </div>

              {/* Creator */}
              <div>
                <dt className="font-medium text-gray-500">登録者</dt>
                <dd className="mt-1 text-gray-700">{ticket.creator.name}</dd>
              </div>

              {/* Created at */}
              <div>
                <dt className="font-medium text-gray-500">作成日</dt>
                <dd className="mt-1 text-gray-700">
                  {ticket.createdAt.toLocaleDateString('ja-JP')}
                </dd>
              </div>

              {/* SLA */}
              {ticket.resolutionDueAt && (
                <div>
                  <dt className="font-medium text-gray-500">解決期限</dt>
                  <dd className="mt-1 flex items-center gap-2">
                    <span className="text-gray-700">
                      {ticket.resolutionDueAt.toLocaleDateString('ja-JP')}
                    </span>
                    {slaState !== 'none' && slaState !== 'ok' && (
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${SLA_COLORS[slaState]}`}
                      >
                        {SLA_LABELS[slaState]}
                      </span>
                    )}
                  </dd>
                </div>
              )}

              {/* Escalation info */}
              {ticket.escalatedAt && (
                <div>
                  <dt className="font-medium text-gray-500">エスカレーション日時</dt>
                  <dd className="mt-1 text-gray-700">
                    {ticket.escalatedAt.toLocaleString('ja-JP')}
                  </dd>
                  {ticket.escalationReason && (
                    <dd className="mt-1 text-xs text-gray-500">{ticket.escalationReason}</dd>
                  )}
                </div>
              )}

              {/* Escalation action */}
              {canEscalate && (
                <div>
                  <dt className="font-medium text-gray-500">エスカレーション</dt>
                  <dd className="mt-1">
                    <EscalationForm ticketId={ticket.id} />
                  </dd>
                </div>
              )}
            </dl>
          </div>
        </aside>
      </div>
    </div>
  );
}
