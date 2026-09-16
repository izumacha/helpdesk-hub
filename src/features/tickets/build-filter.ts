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
import { ALL_TICKET_STATUSES, isCompletedStatus } from '@/domain/ticket-status';
// リポジトリポートが要求するフィルタ型
import type { TicketListFilter } from '@/data/ports/ticket-repository';
// タブ絞り込みを共通ヘルパーに委譲する (mine / overdue タブは一覧とダッシュボードで共有)
// 優先度ごとの SLA 時間表。**アプリ内で唯一の Record<Priority, …>** なので、
// 「存在する優先度の一覧」の導出元として使う (理由は VALID_PRIORITIES のコメント)
import { SLA_RESOLUTION_HOURS_BY_PRIORITY } from '@/lib/sla';
import { applyTabFilter } from '@/features/tickets/tab-filter';
// 期限絞り込み (?due=soon / ?due=today) を共通ヘルパーに委譲する
// (ダッシュボードの SLA 系タイルの件数と drill-down 先の一覧を一致させる。監査フォローアップ 2026-09-09)
import { applyDueFilter, DUE_FILTER_PARAM, parseDueParam } from '@/features/tickets/due-filter';
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

// 有効なステータスの一覧は **ドメインの唯一の参照元から導出する** (ここに書き並べない)。
// /code-review ultra 指摘対応 (2026-09-15): 以前はここで値を列挙し
// 「`as const satisfies TicketStatus[]` が網羅性を検査する」と書いていたが、**それは誤り**。
// `satisfies` が確かめるのは「列挙した各要素が TicketStatus であること」だけで、
// **全部が列挙されていることは検査しない** (実測: 'Escalated' を 1 行消しても
// typecheck も全テストも緑のまま通った)。その状態で domain/types.ts に
// ステータスを足すと、`?status=<新しい値>` が黙って捨てられて一覧も CSV も
// 絞り込み無しの全件になり、filtersClearedByStatusChange も何も外さなくなる
// (このファイルが塞ごうとしている fail-open そのもの)。
// ALL_TICKET_STATUSES は遷移表 ALLOWED_TRANSITIONS のキーから導出されるので、
// Record<TicketStatus, ...> の型検査によって追随が強制される。

// 有効な優先度の一覧も **網羅性が型で強制される宣言から導出する** (ここに書き並べない)。
// 上のステータスとまったく同じ理由: `as const satisfies Priority[]` が確かめるのは
// 「列挙した各要素が Priority であること」だけで、**全部が列挙されていることは検査しない**。
// 実測: domain/types.ts の Priority に値を 1 つ足しても、この宣言に対する型エラーは
// **1 件も出なかった** (落ちたのは Prisma の enum と SLA の表だけで、どちらも
// 優先度を足す作業の一環として直る。取り残されるのはここだけ)。
// その状態で `?priority=<新しい値>` が届くと isValidPriority が false を返し、
// buildTicketListFilter は priority を undefined にするため、
// **一覧も CSV エクスポートも「絞り込み無しの全件」を返す一方でドロップダウンは
// その値を選択済みとして表示する** —— このファイルが塞ごうとしている fail-open そのもの。
// SLA_RESOLUTION_HOURS_BY_PRIORITY は Record<Priority, number> なので、
// Priority に値を足すとキー不足で typecheck が落ち、この一覧も必ず追随する
// (現時点でアプリ内に存在する唯一の Record<Priority, …>。優先度を所有する表が
// 他にできたらそちらへ移す)。
const VALID_PRIORITIES = Object.keys(SLA_RESOLUTION_HOURS_BY_PRIORITY) as Priority[];

/**
 * クエリ文字列のステータスが TicketStatus 列挙に含まれるかを判定する型ガード。
 * URL は信頼できない入力のため、必ずこの関数で検証してから使う。
 */
export function isValidStatus(s: string): s is TicketStatus {
  // ALL_TICKET_STATUSES は遷移表のキーから導出されるので、ステータスの追加に必ず追随する
  return (ALL_TICKET_STATUSES as readonly string[]).includes(s);
}

/**
 * クエリ文字列の優先度が Priority 列挙に含まれるかを判定する型ガード。
 */
export function isValidPriority(p: string): p is Priority {
  // VALID_PRIORITIES は Record<Priority, …> のキーから導出されるので、優先度の追加に必ず追随する
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
 * そのタブは、期限 (?due=...) と同じ軸でチケットを絞るか。
 *
 * **タブが何を絞るかをここに書き写さない** — tabExcludesStatus と同じく applyTabFilter を
 * 実際に通し、立った条件から判定する。
 */
function tabConstrainsDueDate(tab: TicketTabId): boolean {
  // 空の base にタブ条件だけを適用して、そのタブが立てる条件を取り出す
  const applied = applyTabFilter({}, tab, { isAgent: false, userId: '', now: new Date() });
  // 期限超過で絞るタブ ('overdue') だけが ?due= と同じ「期限」軸に条件を立てる
  return applied.overdue !== undefined;
}

/**
 * そのタブは、指定した状態のチケットを結果から必ず除くか。
 *
 * **タブが何を絞るかをここに書き写さない** — 唯一の真実の源である applyTabFilter を
 * 実際に通し、その結果から判定する (タブの条件を変えたときに、この述語だけが
 * 古い前提のまま取り残されるのを防ぐ)。
 */
function tabExcludesStatus(tab: TicketTabId, status: TicketStatus): boolean {
  // 空の base にタブ条件だけを適用して、そのタブが立てる条件を取り出す。
  // isAgent / userId / now は状態の判定に影響しないので代表値でよい
  const applied = applyTabFilter({}, tab, { isAgent: false, userId: '', now: new Date() });
  // 状態を列挙で絞るタブ ('mine') は、その一覧に無い状態を必ず除く
  if (applied.statusIn && !applied.statusIn.includes(status)) return true;
  // 期限超過で絞るタブ ('overdue') は、期限条件と一緒に「終息状態でない」を積む
  // (TicketListFilter.overdue の契約。due-filter と同じ理由)
  if (applied.overdue && isCompletedStatus(status)) return true;
  // それ以外 ('all') は状態を絞らない
  return false;
}

/**
 * 状況 (status) の絞り込みを指定した値に変えるとき、同時に外すべき絞り込みのキーを返す。
 *
 * /code-review ultra 指摘対応 (2026-09-15): タブ切替 (TicketTabs) は
 * 「タブと期限はどちらも期限軸なので、残すと定義上空集合になる組み合わせが 1 クリックで
 * 作れてしまい、0 件の理由が画面から読み取れない」という理由で ?due= を落としていたが、
 * 状況ドロップダウン (TicketFilters) は同じ組み合わせを作れるのに落としていなかった。
 * **2 つの入口で同じ述語を共有する**ため、判定をここに 1 か所だけ置く (§6 DRY)。
 *
 * 矛盾しない組み合わせでは何も外さない — 勝手に解除すると、今度は
 * 「指定した絞り込みが黙って消える」という逆向きの分かりにくさを生む。
 */
export function filtersClearedByStatusChange(
  rawStatus: string, // これから適用する状況 (URL クエリの生文字列)
  rawTab: string | undefined, // 現在のタブ (URL クエリの生文字列。未指定は 'all')
): string[] {
  // 列挙値として読めない値は絞り込み自体が適用されないので、何も外さない
  if (!isValidStatus(rawStatus)) return [];
  // 外すキーを集める入れ物
  const cleared: string[] = [];
  // 期限絞り込みと「未完了のみ」は定義に「未完了であること」を含むので、終息状態とは必ず空集合
  if (isCompletedStatus(rawStatus)) cleared.push(DUE_FILTER_PARAM, OPEN_FILTER_PARAM);
  // 現在のタブがこの状態を除くなら、タブも外す (例: 'mine' タブ + 「解決済み」)
  if (tabExcludesStatus(parseTabParam(rawTab), rawStatus)) cleared.push('tab');
  // 集めたキーを返す (空なら何も外さない)
  return cleared;
}

/**
 * タブを切り替えるとき、同時に外すべき絞り込みのキーを返す
 * (上の filtersClearedByStatusChange の裏返し。同じ述語を共有する)。
 *
 * 片側だけを手当てしても意味が無い: 状況ドロップダウンから来る経路を塞いでも、
 * `?status=Resolved` の一覧で「自分の未対応」タブを押せば同じ「必ず 0 件」に落ちる。
 */
export function filtersClearedByTabChange(
  tab: TicketTabId, // これから適用するタブ
  rawStatus: string | undefined, // 現在の状況 (URL クエリの生文字列)
): string[] {
  // 外すキーを集める入れ物
  const cleared: string[] = [];
  // 期限絞り込みを外すのは、**そのタブが同じ期限軸を絞るときだけ** (= 'overdue')。
  // /code-review ultra 指摘対応: 以前は無条件に外していたため、'all' / 'mine' へ
  // 切り替えるだけで ?due= が黙って消えていた。とくに `/tickets?due=soon`
  // (ダッシュボードの「期限間近」タイルからの遷移) では tab が未指定なので
  // TicketTabs は「すべて」を**現在のタブ**として描画する —— つまり
  // **いま開いているタブを押しただけで絞り込みが外れ**、一覧が全件に戻り、
  // チップも消え、理由が画面のどこにも出ない状態だった。
  // 'all' は条件を 1 つも立てず、'mine' が立てるのは statusIn (Open/InProgress) なので、
  // どちらも ?due= と組み合わせて空集合にはならない (applyTabFilter が正本)。
  // これは同じファイルの filtersClearedByStatusChange が
  // 「矛盾しない組み合わせでは何も外さない — 勝手に解除すると、今度は
  // 『指定した絞り込みが黙って消える』という逆向きの分かりにくさを生む」と
  // 書いている方針そのもので、裏返しの関数だけが従っていなかった
  if (tabConstrainsDueDate(tab)) cleared.push(DUE_FILTER_PARAM);
  // 現在の状況が読めて、かつ新しいタブがその状態を除くなら、状況も外す
  if (rawStatus && isValidStatus(rawStatus) && tabExcludesStatus(tab, rawStatus)) {
    cleared.push('status');
  }
  // 集めたキーを返す
  return cleared;
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
