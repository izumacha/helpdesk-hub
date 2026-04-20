// React の Suspense (子の読み込み待ちで一時的に表示するため)
import { Suspense } from 'react';
// クライアント遷移付きリンク
import Link from 'next/link';
// セッション取得
import { auth } from '@/lib/auth';
// DB クライアント (Prisma)
import { prisma } from '@/lib/prisma';
// エージェント判定 (別名で衝突回避)
import { isAgent as checkIsAgent } from '@/lib/role';
// ステータス/優先度の日本語ラベルとカラークラス
import { STATUS_LABELS, STATUS_COLORS, PRIORITY_LABELS, PRIORITY_COLORS } from '@/lib/constants';
// 検索フィルタフォーム (Client Component)
import { TicketFilters } from '@/features/tickets/components/TicketFilters';
// Prisma が生成した型 (where 構築と enum 検証用)
import type { TicketStatus, Priority, Prisma } from '@/generated/prisma';

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
    page?: string;
  }>;
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

  // Prisma の where 句を組み立てる空オブジェクト
  const where: Prisma.TicketWhereInput = {};

  // RBAC: 依頼者は自分が作成したチケットのみ
  if (!isAgent) {
    where.creatorId = session.user.id;
  }

  // フリーワード検索 (タイトル/本文の部分一致、大文字小文字無視)
  if (sp.q) {
    where.OR = [
      { title: { contains: sp.q, mode: 'insensitive' } },
      { body: { contains: sp.q, mode: 'insensitive' } },
    ];
  }
  // ステータス絞り込み (列挙値として正しい場合のみ適用)
  if (sp.status && isValidStatus(sp.status)) {
    where.status = sp.status as TicketStatus;
  }
  // 優先度絞り込み
  if (sp.priority && isValidPriority(sp.priority)) {
    where.priority = sp.priority as Priority;
  }
  // カテゴリ絞り込み
  if (sp.categoryId) {
    where.categoryId = sp.categoryId;
  }
  // 担当者絞り込み (unassigned 指定なら null)
  if (sp.assigneeId) {
    where.assigneeId = sp.assigneeId === 'unassigned' ? null : sp.assigneeId;
  }

  // 表示用データを並列取得 (一覧/総件数/カテゴリ/担当者候補)
  const [tickets, total, categories, agents] = await Promise.all([
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
    prisma.ticket.count({ where }),
    prisma.category.findMany({ orderBy: { name: 'asc' } }),
    // 担当者プルダウン用ユーザーは agent/admin のみ (依頼者には不要)
    isAgent
      ? prisma.user.findMany({
          where: { role: { in: ['agent', 'admin'] } },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        })
      : Promise.resolve([]),
  ]);

  // 総ページ数を計算
  const totalPages = Math.ceil(total / PAGE_SIZE);
  // 要求ページが総ページを超えていたら最終ページに丸める
  const page = Math.min(requestedPage, Math.max(totalPages, 1));

  return (
    <div>
      {/* ヘッダー: タイトル + 新規登録ボタン */}
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">問い合わせ一覧</h1>
        <Link
          href="/tickets/new"
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          新規登録
        </Link>
      </div>

      {/* 検索フィルタ (Client Component を Suspense で安全にラップ) */}
      <div className="mb-4">
        <Suspense>
          <TicketFilters categories={categories} agents={agents} isAgent={isAgent} />
        </Suspense>
      </div>

      {/* 件数表示 */}
      <p className="mb-2 text-sm text-gray-500">{total} 件</p>

      {/* 一覧テーブル (0 件時は空状態メッセージ) */}
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
                  {/* 件名: 詳細ページへのリンク */}
                  <td className="px-4 py-3">
                    <Link
                      href={`/tickets/${ticket.id}`}
                      className="font-medium text-blue-600 hover:underline"
                    >
                      {ticket.title}
                    </Link>
                  </td>
                  {/* ステータスバッジ */}
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[ticket.status] ?? ''}`}
                    >
                      {STATUS_LABELS[ticket.status] ?? ticket.status}
                    </span>
                  </td>
                  {/* 優先度 (色付きテキスト) */}
                  <td className={`px-4 py-3 ${PRIORITY_COLORS[ticket.priority] ?? ''}`}>
                    {PRIORITY_LABELS[ticket.priority] ?? ticket.priority}
                  </td>
                  {/* カテゴリ名 (なければ "―") */}
                  <td className="px-4 py-3 text-gray-500">{ticket.category?.name ?? '―'}</td>
                  {/* 担当者名 (なければ "未割当") */}
                  <td className="px-4 py-3 text-gray-500">{ticket.assignee?.name ?? '未割当'}</td>
                  {/* 作成日 (日付のみ) */}
                  <td className="px-4 py-3 text-gray-400">
                    {ticket.createdAt.toLocaleDateString('ja-JP')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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

  return (
    <div className="mt-4 flex items-center justify-center gap-2 text-sm">
      {/* 1 ページ目以外でのみ「前へ」を表示 */}
      {page > 1 && (
        <Link href={pageUrl(page - 1)} className="rounded border px-3 py-1 hover:bg-gray-50">
          前へ
        </Link>
      )}
      {/* 現在ページ / 総ページ */}
      <span className="text-gray-500">
        {page} / {totalPages}
      </span>
      {/* 最終ページ以外でのみ「次へ」を表示 */}
      {page < totalPages && (
        <Link href={pageUrl(page + 1)} className="rounded border px-3 py-1 hover:bg-gray-50">
          次へ
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
