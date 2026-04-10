'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useTransition, useCallback } from 'react';
import { STATUS_LABELS, PRIORITY_LABELS } from '@/lib/constants';
import type { TicketStatus, Priority } from '@/generated/prisma';

type Category = { id: string; name: string };
type Agent = { id: string; name: string };

interface Props {
  categories: Category[];
  agents: Agent[];
  isAgent: boolean;
}

const ALL_STATUSES: TicketStatus[] = [
  'New', 'Open', 'WaitingForUser', 'InProgress', 'Escalated', 'Resolved', 'Closed',
];
const ALL_PRIORITIES: Priority[] = ['Low', 'Medium', 'High'];

export function TicketFilters({ categories, agents, isAgent }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const update = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) {
        params.set(key, value);
      } else {
        params.delete(key);
      }
      params.delete('page');
      startTransition(() => router.push(`${pathname}?${params.toString()}`));
    },
    [pathname, router, searchParams],
  );

  const handleReset = () => {
    startTransition(() => router.push(pathname));
  };

  return (
    <div className={`flex flex-wrap items-center gap-2 ${isPending ? 'opacity-50' : ''}`}>
      {/* Keyword */}
      <input
        type="search"
        placeholder="キーワード検索"
        defaultValue={searchParams.get('q') ?? ''}
        onKeyDown={(e) => {
          if (e.key === 'Enter') update('q', (e.target as HTMLInputElement).value.trim());
        }}
        onBlur={(e) => update('q', e.target.value.trim())}
        className="rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
      />
      {/* Status */}
      <select
        value={searchParams.get('status') ?? ''}
        onChange={(e) => update('status', e.target.value)}
        className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
      >
        <option value="">すべてのステータス</option>
        {ALL_STATUSES.map((s) => (
          <option key={s} value={s}>
            {STATUS_LABELS[s] ?? s}
          </option>
        ))}
      </select>
      {/* Priority */}
      <select
        value={searchParams.get('priority') ?? ''}
        onChange={(e) => update('priority', e.target.value)}
        className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
      >
        <option value="">すべての優先度</option>
        {ALL_PRIORITIES.map((p) => (
          <option key={p} value={p}>
            {PRIORITY_LABELS[p] ?? p}
          </option>
        ))}
      </select>
      {/* Category */}
      <select
        value={searchParams.get('categoryId') ?? ''}
        onChange={(e) => update('categoryId', e.target.value)}
        className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
      >
        <option value="">すべてのカテゴリ</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      {/* Assignee (agent/admin only) */}
      {isAgent && (
        <select
          value={searchParams.get('assigneeId') ?? ''}
          onChange={(e) => update('assigneeId', e.target.value)}
          className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
        >
          <option value="">すべての担当者</option>
          <option value="unassigned">未割当</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      )}
      {/* Reset */}
      <button
        onClick={handleReset}
        className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
      >
        リセット
      </button>
    </div>
  );
}
