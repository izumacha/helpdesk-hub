'use client';

// 現在 URL を読み書きするための Next.js フック
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
// 非ブロッキング更新/メモ化/ref 用フック
import { useTransition, useCallback, useRef } from 'react';
// ステータス/優先度の日本語ラベル
import { STATUS_LABELS, PRIORITY_LABELS } from '@/lib/constants';
// 列挙型 (Prisma 生成)
import type { TicketStatus, Priority } from '@/generated/prisma';

// プルダウン項目用の最小限の型
type Category = { id: string; name: string };
type Agent = { id: string; name: string };

// 受け取る props (絞り込み候補と権限フラグ)
interface Props {
  categories: Category[];
  agents: Agent[];
  isAgent: boolean;
}

// プルダウンに並べるステータス/優先度の順序
const ALL_STATUSES: TicketStatus[] = [
  'New', 'Open', 'WaitingForUser', 'InProgress', 'Escalated', 'Resolved', 'Closed',
];
const ALL_PRIORITIES: Priority[] = ['Low', 'Medium', 'High'];

// チケット一覧ページの絞り込み (URL クエリと同期)
export function TicketFilters({ categories, agents, isAgent }: Props) {
  // ルーター/現在パス/検索クエリ
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // 非ブロッキング更新フラグ + トランジション関数
  const [isPending, startTransition] = useTransition();
  // キーワード入力欄の参照 (検索ボタン用)
  const keywordRef = useRef<HTMLInputElement>(null);

  // 1 つのクエリパラメータを更新して URL に反映するヘルパー
  const update = useCallback(
    (key: string, value: string) => {
      // 既存のクエリを複製
      const params = new URLSearchParams(searchParams.toString());
      // 値があればセット、空なら削除
      if (value) {
        params.set(key, value);
      } else {
        params.delete(key);
      }
      // 絞り込み変更時はページ番号を 1 に戻す (page を消す)
      params.delete('page');
      // 非ブロッキングでルーター遷移
      startTransition(() => router.push(`${pathname}?${params.toString()}`));
    },
    [pathname, router, searchParams],
  );

  // 「リセット」: パスのみへ遷移して全クエリを消す
  const handleReset = () => {
    startTransition(() => router.push(pathname));
  };

  return (
    // 絞り込みコントロール群 (送信中は半透明)
    <div className={`flex flex-wrap items-center gap-2 ${isPending ? 'opacity-50' : ''}`}>
      {/* キーワード入力 (Enter または検索ボタンで反映) */}
      <input
        ref={keywordRef}
        type="search"
        placeholder="キーワード検索"
        // クエリ変化時に再マウントして表示値を同期
        key={searchParams.get('q') ?? ''}
        defaultValue={searchParams.get('q') ?? ''}
        onKeyDown={(e) => {
          // Enter キーで即時反映
          if (e.key === 'Enter') update('q', (e.target as HTMLInputElement).value.trim());
        }}
        className="rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
      />
      {/* 検索ボタン */}
      <button
        onClick={() => update('q', keywordRef.current?.value.trim() ?? '')}
        className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
      >
        検索
      </button>
      {/* ステータス絞り込み */}
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
      {/* 優先度絞り込み */}
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
      {/* カテゴリ絞り込み */}
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
      {/* 担当者絞り込み (エージェントのみ表示) */}
      {isAgent && (
        <select
          value={searchParams.get('assigneeId') ?? ''}
          onChange={(e) => update('assigneeId', e.target.value)}
          className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
        >
          <option value="">すべての担当者</option>
          {/* 未割当のチケットのみ */}
          <option value="unassigned">未割当</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      )}
      {/* リセットボタン (全クエリを消す) */}
      <button
        onClick={handleReset}
        className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
      >
        リセット
      </button>
    </div>
  );
}
