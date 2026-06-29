/**
 * チケット一覧のフィルタ条件をURLクエリパラメータから組み立てる純粋関数。
 *
 * /tickets ページと GET /api/tickets/export の両方から呼ばれるため、
 * 一覧と CSV エクスポートが常に同一の絞り込み条件を使えるようにここで一元管理する (DRY 原則)。
 * 'use server' / 'use client' を付けないことでサーバー側・クライアント側の双方向にインポート可能。
 */

// ドメイン型のチケットステータスと優先度 (型ガード用)
import type { TicketStatus, Priority } from '@/domain/types';
// リポジトリポートが要求するフィルタ型
import type { TicketListFilter } from '@/data/ports/ticket-repository';
// タブ絞り込みを共通ヘルパーに委譲する (mine / overdue タブは一覧とダッシュボードで共有)
import { applyTabFilter } from '@/features/tickets/tab-filter';
// 一覧タブ型 — クライアントコンポーネントではなく共有型ファイルから import する (依存境界の明確化)
import type { TicketTabId } from '@/features/tickets/types';

// buildTicketListFilter に渡すURL由来の生文字列パラメータ
export interface TicketFilterParams {
  q?: string; // フリーワード検索
  status?: string; // ステータス (URL クエリは文字列として届く)
  priority?: string; // 優先度 (URL クエリは文字列として届く)
  categoryId?: string; // カテゴリ ID
  assigneeId?: string; // 担当者 ID (または 'unassigned')
  locationId?: string; // 拠点 ID (Phase 4 多拠点)
  tab?: string; // 一覧タブ ('mine' / 'overdue' / 'all' または未指定)
}

// buildTicketListFilter が必要とする実行コンテキスト
export interface TicketFilterContext {
  isAgent: boolean; // 担当者 (agent/admin) かどうか
  userId: string; // ログインユーザー ID
  now: Date; // 現在時刻 (overdue タブの期限判定に使う)
}

// `as const satisfies` で TicketStatus / Priority の全値を列挙する。
// 型システムが「domain/types.ts の union 型と一致しているか」を検査するため、
// domain/types.ts に値を追加してここを更新し忘れると TypeScript エラーになる (ドリフト防止)。
const VALID_STATUSES = [
  'New',
  'Open',
  'WaitingForUser',
  'InProgress',
  'Escalated',
  'Resolved',
  'Closed',
] as const satisfies TicketStatus[];

const VALID_PRIORITIES = ['Low', 'Medium', 'High'] as const satisfies Priority[];

/**
 * クエリ文字列のステータスが TicketStatus 列挙に含まれるかを判定する型ガード。
 * URL は信頼できない入力のため、必ずこの関数で検証してから使う。
 */
export function isValidStatus(s: string): s is TicketStatus {
  // VALID_STATUSES は satisfies TicketStatus[] で型検査済み
  return (VALID_STATUSES as readonly string[]).includes(s);
}

/**
 * クエリ文字列の優先度が Priority 列挙に含まれるかを判定する型ガード。
 */
export function isValidPriority(p: string): p is Priority {
  // VALID_PRIORITIES は satisfies Priority[] で型検査済み
  return (VALID_PRIORITIES as readonly string[]).includes(p);
}

/**
 * URL クエリの assigneeId を Port が期待する形 (`undefined` / `null` / 文字列) に正規化する。
 * - 空文字 / 未指定 → undefined (フィルタなし、全担当者を対象にする)
 * - 'unassigned'   → null    (未アサイン (担当者なし) のチケットのみ)
 * - その他         → 文字列のまま (特定のユーザー ID で完全一致)
 */
export function normalizeAssigneeId(raw: string | undefined): string | null | undefined {
  // 値が無ければフィルタなし
  if (!raw) return undefined;
  // 'unassigned' は未アサイン (null) を意味する
  if (raw === 'unassigned') return null;
  // それ以外はユーザー ID とみなしてそのまま返す
  return raw;
}

/**
 * URL クエリの tab を TicketTabId に正規化する。不正値は 'all' にフォールバックする。
 */
export function parseTabParam(raw: string | undefined): TicketTabId {
  // 'mine' か 'overdue' に完全一致する場合のみ採用、それ以外は既定の 'all'
  if (raw === 'mine' || raw === 'overdue') return raw;
  return 'all';
}

/**
 * URL 由来の生文字列パラメータ + 実行コンテキストから TicketListFilter を組み立てる。
 *
 * /tickets ページ (src/app/(app)/tickets/page.tsx) と
 * GET /api/tickets/export (src/app/api/tickets/export/route.ts) の両方が
 * この関数を呼ぶことで、一覧と CSV エクスポートが常に同じ絞り込みロジックを共有する。
 */
export function buildTicketListFilter(
  params: TicketFilterParams,
  ctx: TicketFilterContext,
): TicketListFilter {
  // RBAC: 依頼者 (requester) は自分が起票したチケットのみ閲覧可能
  // エージェント / 管理者は全チケットを対象にする (creatorId 未指定)
  const baseFilter: TicketListFilter = {
    creatorId: ctx.isAgent ? undefined : ctx.userId,
    // フリーワード検索: タイトルまたは本文を大文字小文字を無視して部分一致
    text: params.q ? { contains: params.q, caseInsensitive: true } : undefined,
    // ステータス絞り込み: 列挙値として正しい場合のみ適用 (不正な文字列は無視する)
    status: params.status && isValidStatus(params.status) ? params.status : undefined,
    // 優先度絞り込み: 列挙値として正しい場合のみ適用
    priority:
      params.priority && isValidPriority(params.priority) ? params.priority : undefined,
    // カテゴリ絞り込み: 空文字は無指定として扱う
    categoryId: params.categoryId || undefined,
    // 担当者絞り込み: 'unassigned' を null に正規化する
    assigneeId: normalizeAssigneeId(params.assigneeId),
    // 拠点絞り込み: 空文字は無指定として扱う (Phase 4 多拠点)
    locationId: params.locationId || undefined,
  };

  // タブ別の追加条件 ('mine' / 'overdue') を共通ヘルパーで適用する
  // (ダッシュボードと同一ロジックを共有し、タブの意味を二重定義しない)
  const tab = parseTabParam(params.tab);
  return applyTabFilter(baseFilter, tab, {
    isAgent: ctx.isAgent,
    userId: ctx.userId,
    now: ctx.now,
  });
}
