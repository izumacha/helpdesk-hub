// クライアント遷移付きリンク
import Link from 'next/link';
// セッション取得
import { auth } from '@/lib/auth';
// DB クライアント (Prisma)
import { prisma } from '@/lib/prisma';
// 「エージェント以上か」を判定 (別名 import で同名変数と区別)
import { isAgent as checkIsAgent } from '@/lib/role';
// ステータスの日本語ラベル + Tailwind カラークラス
import { STATUS_LABELS, STATUS_COLORS } from '@/lib/constants';

// 担当者別集計 (Prisma の groupBy 戻り値) を表す行型
type WorkloadRow = { assigneeId: string | null; _count: { id: number } };

// /dashboard : 集計ダッシュボード (役割で表示項目が変わる)
export default async function DashboardPage() {
  // セッション取得
  const session = await auth();
  // 未ログインなら何も描画しない (middleware 通過後の保険)
  if (!session?.user?.id) return null;

  // ロール判定
  const isAgent = checkIsAgent(session.user.role);
  // 依頼者は自分が作成したチケットだけを集計対象にする
  const baseWhere = isAgent ? {} : { creatorId: session.user.id };
  // SLA 判定基準時刻 (現在時刻)
  const now = new Date();

  // 6 種類のステータス集計 + SLA 超過件数 + 担当者別集計を並列取得
  const [
    newCount,
    openCount,
    inProgressCount,
    escalatedCount,
    resolvedCount,
    waitingCount,
    slaOverdueCount,
    workload,
  ] = await Promise.all([
    // ステータスごとの件数
    prisma.ticket.count({ where: { ...baseWhere, status: 'New' } }),
    prisma.ticket.count({ where: { ...baseWhere, status: 'Open' } }),
    prisma.ticket.count({ where: { ...baseWhere, status: 'InProgress' } }),
    prisma.ticket.count({ where: { ...baseWhere, status: 'Escalated' } }),
    prisma.ticket.count({ where: { ...baseWhere, status: 'Resolved' } }),
    prisma.ticket.count({ where: { ...baseWhere, status: 'WaitingForUser' } }),
    // SLA 超過: 期限切れかつ未解決のチケット数 (エージェントのみ)
    isAgent
      ? prisma.ticket.count({
          where: {
            resolutionDueAt: { lt: now },
            resolvedAt: null,
            status: { notIn: ['Resolved', 'Closed'] },
          },
        })
      : Promise.resolve(0),
    // 担当者別の未完了件数 (エージェントのみ)
    isAgent
      ? prisma.ticket.groupBy({
          by: ['assigneeId'],
          where: { status: { notIn: ['Resolved', 'Closed'] } },
          _count: { id: true },
          orderBy: { _count: { id: 'desc' } },
        })
      : Promise.resolve([]),
  ]);

  // groupBy の戻り値を独自型にキャスト
  const typedWorkload = workload as WorkloadRow[];

  // 表示用に担当者 ID 一覧を抽出 (未割当行は除外)
  const assigneeIds = typedWorkload
    .filter((w) => w.assigneeId !== null)
    .map((w) => w.assigneeId as string);

  // 担当者名を解決するため、ユーザー情報をまとめて取得
  const assigneeNames =
    assigneeIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: assigneeIds } },
          select: { id: true, name: true },
        })
      : [];

  // ID → 名前の辞書を作成
  const nameMap = Object.fromEntries(assigneeNames.map((u) => [u.id, u.name]));

  // ステータスカードに表示する順序付き配列
  const statCards = [
    { status: 'New', count: newCount },
    { status: 'Open', count: openCount },
    { status: 'WaitingForUser', count: waitingCount },
    { status: 'InProgress', count: inProgressCount },
    { status: 'Escalated', count: escalatedCount },
    { status: 'Resolved', count: resolvedCount },
  ];

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold text-gray-900">ダッシュボード</h1>

      {/* ステータス別件数カード群 */}
      <section>
        <h2 className="mb-4 text-sm font-semibold text-gray-500">ステータス別件数</h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          {statCards.map((card) => (
            // カードクリックで該当ステータスのフィルタ済み一覧へ遷移
            <Link
              key={card.status}
              href={`/tickets?status=${card.status}`}
              className="rounded-lg bg-white p-4 shadow-sm transition hover:shadow-md"
            >
              <p className="text-2xl font-bold text-gray-900">{card.count}</p>
              <span
                className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[card.status]}`}
              >
                {STATUS_LABELS[card.status]}
              </span>
            </Link>
          ))}
        </div>
      </section>

      {/* SLA 超過件数 (エージェントのみ表示) */}
      {isAgent && (
        <section>
          <h2 className="mb-4 text-sm font-semibold text-gray-500">SLA 超過</h2>
          <div className="w-40 rounded-lg bg-white p-4 shadow-sm">
            <p className="text-2xl font-bold text-red-600">{slaOverdueCount}</p>
            <p className="mt-1 text-xs text-gray-500">SLA 期限超過件数</p>
          </div>
        </section>
      )}

      {/* 担当者別 未完了件数 (エージェントのみ・データがある場合のみ表示) */}
      {isAgent && typedWorkload.length > 0 && (
        <section>
          <h2 className="mb-4 text-sm font-semibold text-gray-500">担当者別 未完了件数</h2>
          <div className="overflow-hidden rounded-lg bg-white shadow-sm">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">担当者</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">件数</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {typedWorkload.map((row) => {
                  // 表示名 (担当者未割当行は「未割当」、見つからなければ「不明」)
                  const name = row.assigneeId ? (nameMap[row.assigneeId] ?? '不明') : '未割当';
                  // 「一覧を見る」リンク用の検索クエリ
                  const query = row.assigneeId
                    ? `assigneeId=${row.assigneeId}`
                    : 'assigneeId=unassigned';
                  return (
                    <tr key={row.assigneeId ?? 'unassigned'} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-gray-700">{name}</td>
                      <td className="px-4 py-3 text-right font-semibold text-gray-900">
                        {row._count.id}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/tickets?${query}`}
                          className="text-xs text-blue-600 hover:underline"
                        >
                          一覧を見る
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
