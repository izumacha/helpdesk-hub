// クライアント遷移付きリンク
import Link from 'next/link';
// セッション取得
import { auth } from '@/lib/auth';
// データ層の Composition Root (Prisma 直叩きを避ける)
import { repos } from '@/data';
// 「エージェント以上か」を判定 (別名 import で同名変数と区別)
import { isAgent as checkIsAgent } from '@/lib/role';
// ステータスの日本語ラベル(mode 対応) + Tailwind カラークラス
import { getStatusLabel, STATUS_COLORS } from '@/lib/constants';
// 現在テナントの動作モード(lite | pro)を取得するヘルパー
import { getCurrentTenantMode } from '@/lib/tenant';
// Lite モードで表示する 3 ステータス(未対応/対応中/完了)の定義
import { LITE_STATUSES } from '@/domain/ticket-status';
// ステータス型 (statCards の要素型に使用)
import type { TicketStatus } from '@/domain/types';

// /dashboard : 集計ダッシュボード (役割で表示項目が変わる)
export default async function DashboardPage() {
  // セッション取得
  const session = await auth();
  // 未ログインなら何も描画しない (middleware 通過後の保険)
  if (!session?.user?.id) return null;

  // ロール判定
  const isAgent = checkIsAgent(session.user.role);
  // セッションから tenantId を取り出して以降の port 呼び出しに伝搬する
  const tenantId = session.user.tenantId;
  // テナントの動作モード (lite | pro) を取得 (tenantId を渡して二重 session 読み込みを回避)
  const mode = await getCurrentTenantMode(tenantId);
  // Pro モードかどうか (SLA / 担当者別ワークロードの表示判定に使う)
  const isPro = mode === 'pro';
  // SLA 判定基準時刻 (現在時刻)
  const now = new Date();

  // ダッシュボード用 3 指標を 1 メソッドで取得 (内部は groupBy で 3 クエリに集約、tenantId スコープ)
  // - byStatus: 7 状態それぞれの件数 (依頼者なら自身のチケットに限定)
  // - slaOverdue / workload: 当該テナント内全件対象 (表示は呼び出し側で role 制御)
  const stats = await repos.tickets.dashboardStats({
    creatorId: isAgent ? undefined : session.user.id,
    now,
    excludeStatusesForWorkload: ['Resolved', 'Closed'],
    tenantId,
  });

  // SLA 超過件数 (依頼者と Lite テナントには表示しないので 0 にしておく)
  const slaOverdueCount = isAgent && isPro ? stats.slaOverdue : 0;
  // 担当者別ワークロード (依頼者と Lite テナントには表示しないので空配列)
  const workload = isAgent && isPro ? stats.workload : [];

  // 表示用に担当者 ID 一覧を抽出 (未割当行は除外)
  const assigneeIds = workload
    .filter((w) => w.assigneeId !== null)
    .map((w) => w.assigneeId as string);

  // 担当者名を解決するため、当該テナント内のユーザー情報をまとめて取得 (port 経由)
  const assigneeNames =
    assigneeIds.length > 0 ? await repos.users.findSummariesByIds(assigneeIds, tenantId) : [];

  // ID → 名前の辞書を作成
  const nameMap = Object.fromEntries(assigneeNames.map((u) => [u.id, u.name]));

  // カードに表示するステータスの順序。Lite は 3 値(未対応/対応中/完了)、Pro は従来どおり
  const cardStatuses: TicketStatus[] = isPro
    ? ['New', 'Open', 'WaitingForUser', 'InProgress', 'Escalated', 'Resolved']
    : [...LITE_STATUSES];
  // ステータスカードに表示する順序付き配列 (byStatus から件数を引く)
  const statCards = cardStatuses.map((status) => ({
    status,
    count: stats.byStatus[status],
  }));

  // SLA 超過カードのトーン (件数 0 はニュートラル、>0 はロゼで強調)
  const slaIsAlert = slaOverdueCount > 0;

  return (
    <div className="space-y-8">
      {/* ページヘッダー: タイトル + サブテキスト */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">ダッシュボード</h1>
        <p className="mt-1 text-sm text-slate-500">
          {isPro
            ? '現在の対応状況と各担当者の負荷を一目で把握できます。'
            : '現在の対応状況を一目で把握できます。'}
        </p>
      </div>

      {/* ステータス別件数カード群 */}
      <section>
        <h2 className="mb-4 text-xs font-semibold tracking-wider text-slate-500 uppercase">
          ステータス別件数
        </h2>
        <div
          className={`grid grid-cols-2 gap-4 sm:grid-cols-3 ${isPro ? 'lg:grid-cols-6' : 'lg:grid-cols-3'}`}
        >
          {statCards.map((card) => (
            // カードクリックで該当ステータスのフィルタ済み一覧へ遷移
            <Link
              key={card.status}
              href={`/tickets?status=${card.status}`}
              className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100 transition duration-200 hover:-translate-y-0.5 hover:shadow-md hover:ring-teal-200"
            >
              <p className="text-3xl font-bold text-slate-900">{card.count}</p>
              <span
                className={`mt-2 inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[card.status]}`}
              >
                {getStatusLabel(card.status, mode)}
              </span>
            </Link>
          ))}
        </div>
      </section>

      {/* SLA 超過件数 (Pro モードのエージェントのみ表示。Lite では SLA を扱わない) */}
      {isAgent && isPro && (
        <section>
          <h2 className="mb-4 text-xs font-semibold tracking-wider text-slate-500 uppercase">
            SLA 超過
          </h2>
          {/* 件数 0 のとき: ニュートラル / >0 のとき: ロゼで注意喚起 */}
          <div
            className={`w-48 rounded-2xl bg-white p-5 shadow-sm ring-1 transition ${
              slaIsAlert ? 'bg-rose-50/30 ring-rose-200' : 'ring-slate-100'
            }`}
          >
            <p className={`text-3xl font-bold ${slaIsAlert ? 'text-rose-700' : 'text-slate-400'}`}>
              {slaOverdueCount}
            </p>
            <p className="mt-1 text-xs text-slate-500">SLA 期限超過件数</p>
          </div>
        </section>
      )}

      {/* 担当者別 未完了件数 (Pro モードのエージェントのみ・データがある場合のみ表示) */}
      {isAgent && isPro && workload.length > 0 && (
        <section>
          <h2 className="mb-4 text-xs font-semibold tracking-wider text-slate-500 uppercase">
            担当者別 未完了件数
          </h2>
          <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-100">
            <table className="min-w-full divide-y divide-slate-100 text-sm">
              <thead className="bg-slate-50/80">
                <tr>
                  <th className="px-5 py-3 text-left text-[11px] font-semibold tracking-wider text-slate-500 uppercase">
                    担当者
                  </th>
                  <th className="px-5 py-3 text-right text-[11px] font-semibold tracking-wider text-slate-500 uppercase">
                    件数
                  </th>
                  <th className="px-5 py-3 text-right text-[11px] font-semibold tracking-wider text-slate-500 uppercase"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {workload.map((row) => {
                  // 表示名 (担当者未割当行は「未割当」、見つからなければ「不明」)
                  const name = row.assigneeId ? (nameMap[row.assigneeId] ?? '不明') : '未割当';
                  // 「一覧を見る」リンク用の検索クエリ
                  const query = row.assigneeId
                    ? `assigneeId=${row.assigneeId}`
                    : 'assigneeId=unassigned';
                  return (
                    <tr
                      key={row.assigneeId ?? 'unassigned'}
                      className="transition hover:bg-teal-50/40"
                    >
                      <td className="px-5 py-3.5 text-slate-700">{name}</td>
                      <td className="px-5 py-3.5 text-right font-semibold text-slate-900">
                        {row.count}
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        <Link
                          href={`/tickets?${query}`}
                          className="text-xs text-teal-700 transition hover:text-teal-800 hover:underline"
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
