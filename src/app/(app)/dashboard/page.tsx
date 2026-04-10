import Link from 'next/link';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { STATUS_LABELS, STATUS_COLORS } from '@/lib/constants';

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) return null;

  const isAgent = session.user.role === 'agent' || session.user.role === 'admin';

  // Base filter for RBAC
  const baseWhere = isAgent ? {} : { creatorId: session.user.id };

  const now = new Date();

  const [
    newCount,
    openCount,
    inProgressCount,
    escalatedCount,
    resolvedCount,
    waitingCount,
    slaOverdueCount,
    workload,
  ] = await Promise.all([
    prisma.ticket.count({ where: { ...baseWhere, status: 'New' } }),
    prisma.ticket.count({ where: { ...baseWhere, status: 'Open' } }),
    prisma.ticket.count({ where: { ...baseWhere, status: 'InProgress' } }),
    prisma.ticket.count({ where: { ...baseWhere, status: 'Escalated' } }),
    prisma.ticket.count({ where: { ...baseWhere, status: 'Resolved' } }),
    prisma.ticket.count({ where: { ...baseWhere, status: 'WaitingForUser' } }),
    isAgent
      ? prisma.ticket.count({
          where: {
            resolutionDueAt: { lt: now },
            resolvedAt: null,
            status: { notIn: ['Resolved', 'Closed'] },
          },
        })
      : Promise.resolve(0),
    isAgent
      ? prisma.ticket.groupBy({
          by: ['assigneeId'],
          where: { status: { notIn: ['Resolved', 'Closed'] } },
          _count: { id: true },
          orderBy: { _count: { id: 'desc' } },
        })
      : Promise.resolve([]),
  ]);

  // Resolve assignee names for workload
  const assigneeIds = (workload as { assigneeId: string | null; _count: { id: number } }[])
    .filter((w) => w.assigneeId !== null)
    .map((w) => w.assigneeId as string);

  const assigneeNames =
    assigneeIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: assigneeIds } },
          select: { id: true, name: true },
        })
      : [];

  const nameMap = Object.fromEntries(assigneeNames.map((u) => [u.id, u.name]));

  const statCards = [
    { label: '新規', status: 'New', count: newCount, color: STATUS_COLORS['New'] },
    { label: 'オープン', status: 'Open', count: openCount, color: STATUS_COLORS['Open'] },
    { label: 'ユーザー待ち', status: 'WaitingForUser', count: waitingCount, color: STATUS_COLORS['WaitingForUser'] },
    { label: '対応中', status: 'InProgress', count: inProgressCount, color: STATUS_COLORS['InProgress'] },
    { label: 'エスカレーション', status: 'Escalated', count: escalatedCount, color: STATUS_COLORS['Escalated'] },
    { label: '解決済み', status: 'Resolved', count: resolvedCount, color: STATUS_COLORS['Resolved'] },
  ];

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold text-gray-900">ダッシュボード</h1>

      {/* Stats */}
      <section>
        <h2 className="mb-4 text-sm font-semibold text-gray-500">ステータス別件数</h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          {statCards.map((card) => (
            <Link
              key={card.status}
              href={`/tickets?status=${card.status}`}
              className="rounded-lg bg-white p-4 shadow-sm transition hover:shadow-md"
            >
              <p className="text-2xl font-bold text-gray-900">{card.count}</p>
              <span
                className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${card.color}`}
              >
                {card.label}
              </span>
            </Link>
          ))}
        </div>
      </section>

      {/* SLA overdue (agent/admin only) */}
      {isAgent && (
        <section>
          <h2 className="mb-4 text-sm font-semibold text-gray-500">SLA 超過</h2>
          <div className="w-40 rounded-lg bg-white p-4 shadow-sm">
            <p className="text-2xl font-bold text-red-600">{slaOverdueCount}</p>
            <p className="mt-1 text-xs text-gray-500">SLA 期限超過件数</p>
          </div>
        </section>
      )}

      {/* Workload by assignee (agent/admin only) */}
      {isAgent && (workload as { assigneeId: string | null; _count: { id: number } }[]).length > 0 && (
        <section>
          <h2 className="mb-4 text-sm font-semibold text-gray-500">担当者別 未完了件数</h2>
          <div className="overflow-hidden rounded-lg bg-white shadow-sm">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">担当者</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">件数</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {(workload as { assigneeId: string | null; _count: { id: number } }[]).map((row) => {
                  const name = row.assigneeId ? (nameMap[row.assigneeId] ?? '不明') : '未割当';
                  const query = row.assigneeId
                    ? `assigneeId=${row.assigneeId}`
                    : 'assigneeId=unassigned';
                  return (
                    <tr key={row.assigneeId ?? 'unassigned'} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-gray-700">{name}</td>
                      <td className="px-4 py-3 text-right font-semibold text-gray-900">
                        {row._count.id}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/tickets?${query}`}
                          className="text-xs text-blue-600 hover:underline"
                        >
                          一覧を見る
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
