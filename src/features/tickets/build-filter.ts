/**
 * チケット一覧のフィルタ条件をURLクエリパラメータから組み立てる純粋関数。
 *
 * /tickets ページと GET /api/tickets/export の両方から呼ばれるため、
 * 一覧と CSV エクスポートが常に同一の絞り込み条件を使えるようにここで一元管理する (DRY 原則)。
 * 'use server' / 'use client' を付けないことでサーバー側・クライアント側の双方向にインポート可能。
 */

// ドメイン型のチケットステータスと優先度 (型ガード用)
import type { TicketStatus, Priority } from '@/domain/types';
// 終息ステータス (Resolved / Closed) の判定。未完了前提の絞り込みとの矛盾検出に使う
import { isCompletedStatus } from '@/domain/ticket-status';
// リポジトリポートが要求するフィルタ型
import type { TicketListFilter } from '@/data/ports/ticket-repository';
// タブ絞り込みを共通ヘルパーに委譲する (mine / overdue タブは一覧とダッシュボードで共有)
import { applyTabFilter } from '@/features/tickets/tab-filter';
// 期限絞り込み (?due=soon / ?due=today) を共通ヘルパーに委譲する
// (ダッシュボードの SLA 系タイルの件数と drill-down 先の一覧を一致させる。監査フォローアップ 2026-09-09)
import { applyDueFilter, parseDueParam } from '@/features/tickets/due-filter';
// 「未完了のみ」絞り込み (?open=1) を共通ヘルパーに委譲する
// (ダッシュボードの担当者別ワークロードの件数と drill-down 先の一覧を一致させる)
import { applyOpenFilter, OPEN_FILTER_PARAM, parseOpenParam } from '@/features/tickets/open-filter';
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
  due?: string; // 期限絞り込み ('soon' = 期限間近 / 'today' = 期限切れ・今日まで。未指定は絞り込みなし)
  open?: string; // 「未完了のみ」絞り込み ('1' のときだけ有効。未指定は絞り込みなし)
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

// 「未完了であること」を条件に含む絞り込みの URL キー一覧。
// 期限絞り込み (?due=...) は両アダプタが「status が終息状態でない」を必ず AND で積み、
// 「未完了のみ」絞り込み (?open=1) は定義そのものが未完了ステータスの集合なので、
// どちらも終息ステータス (Resolved / Closed) と同時に指定すると **定義上必ず 0 件**になる。
const UNRESOLVED_IMPLYING_FILTER_PARAMS = ['due', OPEN_FILTER_PARAM] as const;

/**
 * 状況 (status) の絞り込みを指定した値に変えるとき、同時に外すべき絞り込みのキーを返す。
 *
 * /code-review ultra 指摘対応 (2026-09-15): タブ切替 (TicketTabs) は
 * 「タブと期限はどちらも期限軸なので、残すと定義上空集合になる組み合わせが 1 クリックで
 * 作れてしまい、0 件の理由が画面から読み取れない」という理由で ?due= を落としていたが、
 * 状況ドロップダウン (TicketFilters) は同じ組み合わせを作れるのに落としていなかった。
 * `?due=soon` の一覧 (ダッシュボードの「期限間近」タイルからの遷移先) で状況に
 * 「解決済み」を選ぶと、同じ「必ず 0 件」の状態へ 1 クリックで落ちる。
 * どちらの入口も同じ方針にそろえるため、判定をここに 1 か所だけ置く (§6 DRY)。
 *
 * 終息ステータス以外 (未完了ステータス・空文字・列挙外の値) では何も外さない —
 * 矛盾しない組み合わせまで勝手に解除すると、今度は「指定した絞り込みが黙って消える」
 * という逆向きの分かりにくさを生む。
 */
export function filtersClearedByStatusChange(rawStatus: string): string[] {
  // 列挙値として読めない値は絞り込み自体が適用されないので、何も外さない
  if (!isValidStatus(rawStatus)) return [];
  // 未完了ステータスなら矛盾しないので、何も外さない
  if (!isCompletedStatus(rawStatus)) return [];
  // 終息ステータスのときだけ、未完了を前提にする絞り込みを外す
  return [...UNRESOLVED_IMPLYING_FILTER_PARAMS];
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
    priority: params.priority && isValidPriority(params.priority) ? params.priority : undefined,
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
  const tabApplied = applyTabFilter(baseFilter, tab, {
    isAgent: ctx.isAgent,
    userId: ctx.userId,
    now: ctx.now,
  });
  // 「未完了のみ」条件 ('1' のときだけ) を共通ヘルパーで適用する
  // (ダッシュボードのワークロード件数と同一ロジックを共有し、未完了の定義を二重定義しない)
  const openApplied = parseOpenParam(params.open) ? applyOpenFilter(tabApplied) : tabApplied;
  // 期限絞り込み ('soon' / 'today') を共通ヘルパーで適用する
  // (ダッシュボードのタイル件数と同一ロジックを共有し、期限条件の意味を二重定義しない)
  const due = parseDueParam(params.due);
  // 不正値・未指定は絞り込みなし (isValidStatus 等と同じ「列挙外は無視」の方針)
  if (!due) return openApplied;
  // 期限条件を追加したフィルタを返す
  return applyDueFilter(openApplied, due, { now: ctx.now });
}
