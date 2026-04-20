'use client';

// 非ブロッキングでアクションを呼ぶフック
import { useTransition } from 'react';
// ステータス更新サーバーアクション
import { updateTicketStatus } from '@/features/tickets/actions/update-ticket';
// ステータスの日本語ラベル
import { STATUS_LABELS } from '@/lib/constants';
// 現ステータスから許可される遷移先一覧を返すドメイン関数
import { getAllowedTransitions } from '@/domain/ticket-status';
// ステータス型 (Prisma 生成)
import type { TicketStatus } from '@/generated/prisma';

// 受け取る props (チケット ID と現在ステータス)
interface Props {
  ticketId: string;
  current: TicketStatus;
}

// ステータスを切り替えるプルダウン (許可された遷移のみ表示)
export function StatusSelect({ ticketId, current }: Props) {
  // 送信中フラグ + トランジション
  const [isPending, startTransition] = useTransition();
  // 現状から遷移可能な次状態の一覧
  const allowed = getAllowedTransitions(current);

  // 選択変更でアクションを呼ぶ
  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value as TicketStatus;
    startTransition(() => updateTicketStatus(ticketId, next));
  }

  // 遷移先が無いならプルダウン自体を出さない
  if (allowed.length === 0) return null;

  return (
    <select
      value={current}
      onChange={handleChange}
      disabled={isPending}
      className="rounded-md border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50"
    >
      {/* 現在値はプレースホルダ的に disabled で表示 */}
      <option value={current} disabled>
        {STATUS_LABELS[current] ?? current}
      </option>
      {/* 許可された遷移先のみを option として並べる */}
      {allowed.map((s) => (
        <option key={s} value={s}>
          {STATUS_LABELS[s] ?? s}
        </option>
      ))}
    </select>
  );
}
