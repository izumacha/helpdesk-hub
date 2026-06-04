'use client';

// 非ブロッキングでアクションを呼ぶフック
import { useTransition } from 'react';
// ステータス更新サーバーアクション
import { updateTicketStatus } from '@/features/tickets/actions/update-ticket';
// ステータスの日本語ラベルを mode (lite | pro) に応じて返す mode-aware ヘルパー
import { getStatusLabel } from '@/lib/constants';
// 現ステータスから許可される遷移先一覧を返すドメイン関数 (mode に応じて Lite/Pro 表を切替)
import { getAllowedTransitions } from '@/domain/ticket-status';
// ステータス型 (正準のドメイン型)
import type { TicketStatus } from '@/domain/types';
// テナントモード型 (lite | pro)。ラベルと遷移表の切替に使う
import type { TenantMode } from '@/domain/types';

// 受け取る props (チケット ID と現在ステータスと、表示切替用テナントモード)
interface Props {
  ticketId: string;
  current: TicketStatus;
  mode: TenantMode;
}

// ステータスを切り替えるプルダウン (許可された遷移のみ表示)
export function StatusSelect({ ticketId, current, mode }: Props) {
  // 送信中フラグ + トランジション
  const [isPending, startTransition] = useTransition();
  // 現状から遷移可能な次状態の一覧 (mode に応じて Lite なら 3 値遷移表、Pro なら 7 値遷移表)
  const allowed = getAllowedTransitions(current, mode);

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
      {/* 現在値はプレースホルダ的に disabled で表示 (mode に応じて Lite/Pro ラベル) */}
      <option value={current} disabled>
        {getStatusLabel(current, mode)}
      </option>
      {/* 許可された遷移先のみを option として並べる (mode に応じて Lite/Pro ラベル) */}
      {allowed.map((s) => (
        <option key={s} value={s}>
          {getStatusLabel(s, mode)}
        </option>
      ))}
    </select>
  );
}
