'use client';

// 現在 URL を読み書きするための Next.js フック
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
// 非ブロッキング更新/メモ化/ref 用フック
import { useTransition, useCallback, useRef } from 'react';
// ステータスの日本語ラベルを mode (lite | pro) に応じて返す mode-aware ヘルパーと優先度ラベル
import { getStatusLabel, PRIORITY_LABELS } from '@/lib/constants';
// Lite モードで使う 3 ステータス (未対応 / 対応中 / 完了) の定義
import { LITE_STATUSES } from '@/domain/ticket-status';
// 列挙型 (Prisma 生成)
import type { TicketStatus, Priority } from '@/domain/types';
// テナントモード型 (lite | pro)。フィルタ選択肢とラベルの切替に使う
import type { TenantMode } from '@/domain/types';

// プルダウン項目用の最小限の型
type Category = { id: string; name: string };
type Agent = { id: string; name: string };

// 受け取る props (絞り込み候補と権限フラグ、テナントの動作モード)
interface Props {
  categories: Category[];
  agents: Agent[];
  isAgent: boolean;
  mode: TenantMode;
}

// プルダウンに並べる Pro モード用ステータス/優先度の順序 (7 値)
const ALL_STATUSES_PRO: TicketStatus[] = [
  'New',
  'Open',
  'WaitingForUser',
  'InProgress',
  'Escalated',
  'Resolved',
  'Closed',
];
const ALL_PRIORITIES: Priority[] = ['Low', 'Medium', 'High'];

// 入力/プルダウンに共通で当てるクラス (フォーカス時のティールリングを統一)
const fieldBaseClass =
  'rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 transition focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/30';

// チケット一覧ページの絞り込み (URL クエリと同期)
export function TicketFilters({ categories, agents, isAgent, mode }: Props) {
  // テナントが Lite なら 3 値、Pro なら従来 7 値をフィルタ候補として使う
  const statusOptions: TicketStatus[] = mode === 'lite' ? [...LITE_STATUSES] : ALL_STATUSES_PRO;
  // Lite モードかどうか (true ならフィルタをキーワード検索のみに縮約する)
  // Pivot plan §3.1「Lite はフリーワード検索のみ」要件に対応
  const isLite = mode === 'lite';
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

  // 「リセット」: パスのみへ遷移して全クエリを消す (tab クエリも消えるが既定タブに戻す挙動でよい)
  const handleReset = () => {
    startTransition(() => router.push(pathname));
  };

  return (
    // フィルタを 1 つの柔らかなパネルに収める (健診カウンター風)
    <div
      className={`rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200 transition ${isPending ? 'opacity-60' : ''}`}
    >
      {/* 絞り込みコントロール群 (折り返し可能) */}
      <div className="flex flex-wrap items-center gap-2">
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
          className={`${fieldBaseClass} min-w-56 flex-1`}
        />
        {/* 検索ボタン (主要 CTA をティールに) */}
        <button
          onClick={() => update('q', keywordRef.current?.value.trim() ?? '')}
          className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-teal-800"
        >
          検索
        </button>
        {/* Lite モードではキーワード検索のみに縮約し、以下のプルダウン群は非表示にする */}
        {!isLite && (
          <>
            {/* ステータス絞り込み */}
            <select
              value={searchParams.get('status') ?? ''}
              onChange={(e) => update('status', e.target.value)}
              className={fieldBaseClass}
            >
              <option value="">すべてのステータス</option>
              {statusOptions.map((s) => (
                <option key={s} value={s}>
                  {getStatusLabel(s, mode)}
                </option>
              ))}
            </select>
            {/* 優先度絞り込み */}
            <select
              value={searchParams.get('priority') ?? ''}
              onChange={(e) => update('priority', e.target.value)}
              className={fieldBaseClass}
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
              className={fieldBaseClass}
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
                className={fieldBaseClass}
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
          </>
        )}
        {/* リセットボタン (ghost スタイル) */}
        <button
          onClick={handleReset}
          className="rounded-lg px-3 py-2 text-sm text-slate-500 transition hover:bg-white hover:text-slate-800"
        >
          リセット
        </button>
      </div>
    </div>
  );
}
