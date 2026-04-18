import { Suspense } from 'react';
import Link from 'next/link';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { isAgent as checkIsAgent } from '@/lib/role';
import { STATUS_LABELS, STATUS_COLORS, PRIORITY_LABELS, PRIORITY_COLORS } from '@/lib/constants';
import { TicketFilters } from '@/features/tickets/components/TicketFilters';
import { clampPage, parsePageParam } from '@/lib/validations/pagination';
import type { TicketStatus, Priority, Prisma } from '@/generated/prisma';

const PAGE_SIZE = 20;

interface Props {
  searchParams: Promise<{
    q?: string;
    status?: string;
    priority?: string;
    categoryId?: string;
    assigneeId?: string;
    page?: string;
  }>;
}

export default async function TicketsPage({ searchParams }: Props) {
  const sp = await searchParams;
  const session = await auth();
  if (!session?.user?.id) return null;

  const isAgent = checkIsAgent(session.user.role);
  const requestedPage = parsePageParam(sp.page);

  // Build Prisma where clause
  const where: Prisma.TicketWhereInput = {};

  // RBAC: requesters see only their own tickets
  if (!isAgent) {
    where.creatorId = session.user.id;
  }

  if (sp.q) {
    where.OR = [
      { title: { contains: sp.q, mode: 'insensitive' } },
      { body: { contains: sp.q, mode: 'insensitive' } },
    ];
  }
  if (sp.status && isValidStatus(sp.status)) {
    where.status = sp.status as TicketStatus;
  }
  if (sp.priority && isValidPriority(sp.priority)) {
    where.priority = sp.priority as Priority;
  }
  if (sp.categoryId) {
    where.categoryId = sp.categoryId;
  }
  if (sp.assigneeId) {
    where.assigneeId = sp.assigneeId === 'unassigned' ? null : sp.assigneeId;
  }

  const total = await prisma.ticket.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = clampPage(requestedPage, totalPages);
  const skip = (page - 1) * PAGE_SIZE;

  const [tickets, categories, agents] = await Promise.all([
    prisma.ticket.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: PAGE_SIZE,
      include: {
        creator: { select: { id: true, name: true } },
        assignee: { select: { id: true, name: true } },
        category: { select: { id: true, name: true } },
      },
    }),
    prisma.category.findMany({ orderBy: { name: 'asc' } }),
    isAgent
      ? prisma.user.findMany({
          where: { role: { in: ['agent', 'admin'] } },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        })
      : Promise.resolve([]),
  ]);

  return (
    <div>
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">問い合わせ一覧</h1>
        <Link
          href="/tickets/new"
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          新規登録
        </Link>
      </div>

      {/* Filters */}
      <div className="mb-4">
        <Suspense>
          <TicketFilters categories={categories} agents={agents} isAgent={isAgent} />
        </Suspense>
      </div>

      {/* Count */}
      <p className="mb-2 text-sm text-gray-500">{total} 件</p>

      {/* Table */}
      {tickets.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 py-16 text-center text-gray-400">
          条件に一致する問い合わせはありません
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">件名</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">ステータス</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">優先度</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">カテゴリ</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">担当者</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">作成日</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {tickets.map((ticket) => (
                <tr key={ticket.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <Link
                      href={`/tickets/${ticket.id}`}
                      className="font-medium text-blue-600 hover:underline"
                    >
                      {ticket.title}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[ticket.status] ?? ''}`}
                    >
                      {STATUS_LABELS[ticket.status] ?? ticket.status}
                    </span>
                  </td>
                  <td className={`px-4 py-3 ${PRIORITY_COLORS[ticket.priority] ?? ''}`}>
                    {PRIORITY_LABELS[ticket.priority] ?? ticket.priority}
                  </td>
                  <td className="px-4 py-3 text-gray-500">{ticket.category?.name ?? '―'}</td>
                  <td className="px-4 py-3 text-gray-500">{ticket.assignee?.name ?? '未割当'}</td>
                  <td className="px-4 py-3 text-gray-400">
                    {ticket.createdAt.toLocaleDateString('ja-JP')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && <Pagination page={page} totalPages={totalPages} sp={sp} />}
    </div>
  );
}

function Pagination({
  page,
  totalPages,
  sp,
}: {
  page: number;
  totalPages: number;
  sp: Record<string, string | undefined>;
}) {
  function pageUrl(p: number) {
    const params = new URLSearchParams(
      Object.entries(sp)
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .map(([k, v]) => [k, v]),
    );
    params.set('page', String(p));
    return `/tickets?${params.toString()}`;
  }

  return (
    <div className="mt-4 flex items-center justify-center gap-2 text-sm">
      {page > 1 && (
        <Link href={pageUrl(page - 1)} className="rounded border px-3 py-1 hover:bg-gray-50">
          前へ
        </Link>
      )}
      <span className="text-gray-500">
        {page} / {totalPages}
      </span>
      {page < totalPages && (
        <Link href={pageUrl(page + 1)} className="rounded border px-3 py-1 hover:bg-gray-50">
          次へ
        </Link>
      )}
    </div>
  );
}

function isValidStatus(s: string): s is TicketStatus {
  return [
    'New',
    'Open',
    'WaitingForUser',
    'InProgress',
    'Escalated',
    'Resolved',
    'Closed',
  ].includes(s);
}

function isValidPriority(p: string): p is Priority {
  return ['Low', 'Medium', 'High'].includes(p);
}
