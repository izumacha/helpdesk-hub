// React の Suspense (子の読み込み待ちで一時的に表示するため)
import { Suspense } from 'react';
// クライアント遷移付きリンク
import Link from 'next/link';
// セッション取得
import { auth } from '@/lib/auth';
// データ層の Composition Root (Prisma 直叩きを避ける)
import { repos } from '@/data';
// エージェント判定 (別名で衝突回避)
import { isAgent as checkIsAgent } from '@/lib/role';
// ステータスの日本語ラベルを mode (lite | pro) に応じて返す mode-aware ヘルパーと、色/優先度ラベル
import { getStatusLabel, STATUS_COLORS, PRIORITY_LABELS, PRIORITY_COLORS } from '@/lib/constants';
// 現在ログイン中のテナントの動作モード (lite | pro) を取得するヘルパー
import { getCurrentTenantMode } from '@/lib/tenant';
// 日本時間 (Asia/Tokyo) で日付を文字列化するユーティリティ
import { formatDateJP } from '@/lib/format-date';
// 検索フィルタフォーム (Client Component)
import { TicketFilters } from '@/features/tickets/components/TicketFilters';
// 「自分の未対応 / 期限切れ / すべて」タブナビ (Client Component)
import { TicketTabs, type TicketTabId } from '@/features/tickets/components/TicketTabs';
// Prisma が生成した列挙型 (URL クエリの型ガード用)
import type { TicketStatus, Priority } from '@/generated/prisma';
// データ層が公開しているチケット一覧フィルタ型 (port 経由クエリの引数)
import type { TicketListFilter } from '@/data/ports/ticket-repository';

// 1 ページあたりの表示件数
const PAGE_SIZE = 20;
// 異常に大きいページ番号で攻撃されないよう上限を設定
const MAX_PAGE = 10_000;

// クエリ文字列の page を整数に変換し、不正なら 1 にフォールバック
function parsePageParam(raw: string | undefined): number {
  // 値が無ければ 1 ページ目
  if (!raw) return 1;
  // 数値化
  const n = Number(raw);
  // 整数でない or 1 未満は 1 ページ目に
  if (!Number.isInteger(n) || n < 1) return 1;
  // 上限を超えたら MAX_PAGE に丸める
  return Math.min(n, MAX_PAGE);
}

// /tickets ページの props 型 (URL の検索クエリを受け取る)
interface Props {
  searchParams: Promise<{
    q?: string;
    status?: string;
    priority?: string;
    categoryId?: string;
    assigneeId?: string;
    // 一覧の絞り込みタブ ('mine' = 自分の未対応 / 'overdue' = 期限切れ / 未指定/'all' = 全件)
    tab?: string;
    page?: string;
  }>;
}

// クエリの tab 文字列を TicketTabId に正規化する (不正値は 'all')
function parseTabParam(raw: string | undefined): TicketTabId {
  // 'mine' か 'overdue' に完全一致する場合のみ採用、それ以外は既定の 'all'
  if (raw === 'mine' || raw === 'overdue') return raw;
  return 'all';
}

// /tickets : チケット一覧ページ (検索/フィルタ + ページング)
export default async function TicketsPage({ searchParams }: Props) {
  // searchParams は Promise なので await して取り出す
  const sp = await searchParams;
  // セッション取得
  const session = await auth();
  // 未ログインなら描画しない
  if (!session?.user?.id) return null;

  // ロール判定
  const isAgent = checkIsAgent(session.user.role);
  // 要求ページ番号と DB の skip 件数を計算
  const requestedPage = parsePageParam(sp.page);
  const skip = (requestedPage - 1) * PAGE_SIZE;
  // タブ ID を正規化 ('all' / 'mine' / 'overdue' のいずれか)
  const tab = parseTabParam(sp.tab);

  // データ層に渡す TicketListFilter を組み立てる
  const filter: TicketListFilter = {
    // RBAC: 依頼者は自分のチケットのみ (エージェントは creatorId 未指定 = 全件)
    creatorId: isAgent ? undefined : session.user.id,
    // フリーワード検索 (タイトル/本文の部分一致、大文字小文字無視)
    text: sp.q ? { contains: sp.q, caseInsensitive: true } : undefined,
    // ステータス絞り込み (列挙値として正しい場合のみ適用)
    status: sp.status && isValidStatus(sp.status) ? sp.status : undefined,
    // 優先度絞り込み
    priority: sp.priority && isValidPriority(sp.priority) ? sp.priority : undefined,
    // カテゴリ絞り込み (空文字は無指定として扱う)
    categoryId: sp.categoryId || undefined,
    // 担当者絞り込み (URL クエリの 'unassigned' をここで null に正規化)
    assigneeId: normalizeAssigneeId(sp.assigneeId),
  };

  // タブ別の追加フィルタを上書き適用する
  // - mine: 「自分の未対応」= ステータスが Open または InProgress
  //   - エージェントは「担当が自分」のもの
  //   - 依頼者は creatorId 既定 (自分のチケット) で自動的に絞り込まれているため status だけ追加
  // - overdue: 期限切れ + 未解決 (status=Resolved/Closed は除外)
  if (tab === 'mine') {
    filter.statusIn = ['Open', 'InProgress'];
    if (isAgent) {
      filter.assigneeId = session.user.id;
    }
  } else if (tab === 'overdue') {
    // 現在時刻基準で期限超過判定を行う
    filter.overdue = { now: new Date() };
  }

  // セッションから tenantId を取り出して以降の port 呼び出しに伝搬する
  const tenantId = session.user.tenantId;
  // 表示用データを並列取得 (一覧/総件数/カテゴリ/担当者候補/テナント mode、全て port + tenantId スコープ)
  const [tickets, total, categories, agents, mode] = await Promise.all([
    repos.tickets.list({
      filter,
      page: { skip, take: PAGE_SIZE },
      sort: { field: 'createdAt', direction: 'desc' },
      tenantId,
    }),
    repos.tickets.count(filter, tenantId),
    repos.categories.list(tenantId),
    // 担当者プルダウン用ユーザーは agent/admin のみ (依頼者には不要)
    isAgent ? repos.users.listAgents(tenantId) : Promise.resolve([]),
    // テナントの動作モード (lite | pro) を取得し、ステータス表記を Lite/Pro で切り替える
    getCurrentTenantMode(tenantId),
  ]);

  // 総ページ数を計算
  const totalPages = Math.ceil(total / PAGE_SIZE);
  // 要求ページが総ページを超えていたら最終ページに丸める
  const page = Math.min(requestedPage, Math.max(totalPages, 1));

  return (
    <div className="space-y-6">
      {/* ヘッダー: タイトル + 説明文 + 新規登録ボタン */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">問い合わせ一覧</h1>
          <p className="mt-1 text-sm text-slate-500">
            社内からの問い合わせを一元管理し、対応状況を追跡します。
          </p>
        </div>
        <Link
          href="/tickets/new"
          className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-800"
        >
          ＋ 新規登録
        </Link>
      </div>

      {/* タブナビ (自分の未対応 / 期限切れ / すべて)。Lite/Pro どちらでも常に表示する */}
      <Suspense>
        <TicketTabs />
      </Suspense>

      {/* 検索フィルタ (Client Component を Suspense で安全にラップ、テナント mode をそのまま伝搬) */}
      <Suspense>
        <TicketFilters categories={categories} agents={agents} isAgent={isAgent} mode={mode} />
      </Suspense>

      {/* 件数表示 (落ち着いたグレー) */}
      <p className="text-sm text-slate-500">{total} 件</p>

      {/* 一覧 (0 件時は空状態 / それ以外は md 以上でテーブル、md 未満でカード列を出し分け) */}
      {tickets.length === 0 ? (
        // 0 件時の空状態 (柔らかなカード) ─ 病院待合室の余白感
        <div className="rounded-2xl bg-white py-20 text-center text-slate-400 ring-1 ring-slate-200">
          <p className="text-sm">条件に一致する問い合わせはありません</p>
        </div>
      ) : (
        <>
          {/* デスクトップ用テーブル (md 以上で表示。情シス向けの密度の高い一覧) */}
          <div className="hidden overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-100 md:block">
            <table className="min-w-full divide-y divide-slate-100 text-sm">
              <thead className="bg-slate-50/80">
                <tr>
                  <th className="px-5 py-3 text-left text-[11px] font-semibold tracking-wider text-slate-500 uppercase">
                    件名
                  </th>
                  <th className="px-5 py-3 text-left text-[11px] font-semibold tracking-wider text-slate-500 uppercase">
                    ステータス
                  </th>
                  <th className="px-5 py-3 text-left text-[11px] font-semibold tracking-wider text-slate-500 uppercase">
                    優先度
                  </th>
                  <th className="px-5 py-3 text-left text-[11px] font-semibold tracking-wider text-slate-500 uppercase">
                    カテゴリ
                  </th>
                  <th className="px-5 py-3 text-left text-[11px] font-semibold tracking-wider text-slate-500 uppercase">
                    担当者
                  </th>
                  <th className="px-5 py-3 text-left text-[11px] font-semibold tracking-wider text-slate-500 uppercase">
                    作成日
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {tickets.map((ticket) => (
                  <tr key={ticket.id} className="transition hover:bg-teal-50/40">
                    {/* 件名: 詳細ページへのリンク */}
                    <td className="px-5 py-3.5">
                      <Link
                        href={`/tickets/${ticket.id}`}
                        className="font-medium text-slate-900 transition hover:text-teal-700"
                      >
                        {ticket.title}
                      </Link>
                    </td>
                    {/* ステータスバッジ (テナント mode に応じて Lite/Pro ラベルを切替) */}
                    <td className="px-5 py-3.5">
                      <span
                        className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[ticket.status] ?? ''}`}
                      >
                        {getStatusLabel(ticket.status, mode)}
                      </span>
                    </td>
                    {/* 優先度 (色付きテキスト) */}
                    <td className={`px-5 py-3.5 ${PRIORITY_COLORS[ticket.priority] ?? ''}`}>
                      {PRIORITY_LABELS[ticket.priority] ?? ticket.priority}
                    </td>
                    {/* カテゴリ名 (なければ "―") */}
                    <td className="px-5 py-3.5 text-slate-500">{ticket.category?.name ?? '―'}</td>
                    {/* 担当者名 (なければ "未割当") */}
                    <td className="px-5 py-3.5 text-slate-500">
                      {ticket.assignee?.name ?? '未割当'}
                    </td>
                    {/* 作成日 (日付のみ・日本時間) */}
                    <td className="px-5 py-3.5 text-slate-400">
                      {/* 一覧の作成日を日本時間 (年月日) で表示する */}
                      {formatDateJP(ticket.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* モバイル用カード (md 未満で表示。1 件 1 カードで全要素を縦に積む) */}
          <ul className="space-y-3 md:hidden">
            {tickets.map((ticket) => (
              <li
                key={ticket.id}
                // 白カード + 影 + 境界線で 1 件をひとまとまりに見せる
                className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100"
              >
                {/* 件名: カード全体をタップ領域にするためブロックリンク化 */}
                <Link
                  href={`/tickets/${ticket.id}`}
                  className="block text-base font-medium text-slate-900 transition hover:text-teal-700"
                >
                  {ticket.title}
                </Link>
                {/* バッジ行: ステータス + 優先度 (折り返し可能) */}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span
                    className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[ticket.status] ?? ''}`}
                  >
                    {getStatusLabel(ticket.status, mode)}
                  </span>
                  <span
                    className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${PRIORITY_COLORS[ticket.priority] ?? ''}`}
                  >
                    {PRIORITY_LABELS[ticket.priority] ?? ticket.priority}
                  </span>
                </div>
                {/* メタ情報行: カテゴリ / 担当者 / 作成日 (ラベル付きで小さく) */}
                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs text-slate-500">
                  <div className="col-span-2 flex justify-between">
                    <dt className="text-slate-400">カテゴリ</dt>
                    <dd className="text-slate-600">{ticket.category?.name ?? '―'}</dd>
                  </div>
                  <div className="col-span-2 flex justify-between">
                    <dt className="text-slate-400">担当者</dt>
                    <dd className="text-slate-600">{ticket.assignee?.name ?? '未割当'}</dd>
                  </div>
                  <div className="col-span-2 flex justify-between">
                    <dt className="text-slate-400">作成日</dt>
                    <dd className="text-slate-600">{formatDateJP(ticket.createdAt)}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* 総ページ数が 2 以上のときのみページャを表示 */}
      {totalPages > 1 && <Pagination page={page} totalPages={totalPages} sp={sp} />}
    </div>
  );
}

// ページャ (前へ / 現在 / 次へ) の表示コンポーネント
function Pagination({
  page,
  totalPages,
  sp,
}: {
  page: number;
  totalPages: number;
  sp: Record<string, string | undefined>;
}) {
  // 現在のクエリを引き継ぎつつ page だけ差し替えた URL を作る
  function pageUrl(p: number) {
    // undefined を除外し URLSearchParams に詰め直す
    const params = new URLSearchParams(
      Object.entries(sp)
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .map(([k, v]) => [k, v]),
    );
    params.set('page', String(p));
    return `/tickets?${params.toString()}`;
  }

  // ページャ用ボタンの共通クラス (健診的に丸みのある柔らかなボタン)
  const pagerLinkClass =
    'rounded-full bg-white px-4 py-1.5 text-slate-600 ring-1 ring-slate-200 transition hover:bg-teal-50 hover:text-teal-800';

  return (
    <div className="mt-2 flex items-center justify-center gap-3 text-sm">
      {/* 1 ページ目以外でのみ「前へ」を表示 */}
      {page > 1 && (
        <Link href={pageUrl(page - 1)} className={pagerLinkClass}>
          ← 前へ
        </Link>
      )}
      {/* 現在ページ / 総ページ */}
      <span className="text-slate-500">
        {page} / {totalPages}
      </span>
      {/* 最終ページ以外でのみ「次へ」を表示 */}
      {page < totalPages && (
        <Link href={pageUrl(page + 1)} className={pagerLinkClass}>
          次へ →
        </Link>
      )}
    </div>
  );
}

// クエリ文字列のステータスが TicketStatus に含まれるかを判定 (型ガード)
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

// クエリ文字列の優先度が Priority に含まれるかを判定 (型ガード)
function isValidPriority(p: string): p is Priority {
  return ['Low', 'Medium', 'High'].includes(p);
}

// URL クエリの assigneeId を Port が期待する形 (`undefined` / `null` / 文字列) に正規化する
// - 空文字 / 未指定 → undefined (フィルタなし)
// - 'unassigned' → null (未アサインのみ)
// - その他 → 文字列のまま (担当者 ID で完全一致)
function normalizeAssigneeId(raw: string | undefined): string | null | undefined {
  // 値が無ければフィルタなし
  if (!raw) return undefined;
  // 'unassigned' は未アサイン (null) を意味する
  if (raw === 'unassigned') return null;
  // それ以外はユーザー ID とみなしてそのまま返す
  return raw;
}
