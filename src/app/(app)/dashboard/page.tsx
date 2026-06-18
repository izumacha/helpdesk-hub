// クライアント遷移付きリンク
import Link from 'next/link';
// セッション取得
import { auth } from '@/lib/auth';
// データ層の Composition Root (Prisma 直叩きを避ける)
import { repos } from '@/data';
// 「エージェント以上か」を判定 (別名 import で同名変数と区別)
import { isAgent as checkIsAgent } from '@/lib/role';
// ステータスの日本語ラベル + Tailwind カラークラス
import { STATUS_LABELS, STATUS_COLORS } from '@/lib/constants';
// 現在ログイン中のテナントの動作モード (lite | pro) を取得するヘルパー
import { getCurrentTenantMode } from '@/lib/tenant';
// タブ ('mine' / 'overdue') の絞り込み条件を一元管理する純粋関数 (一覧ページと共有)
import { applyTabFilter } from '@/features/tickets/tab-filter';
// データ層が公開しているチケット一覧フィルタ型 (件数取得の引数)
import type { TicketListFilter } from '@/data/ports/ticket-repository';

// /dashboard : 集計ダッシュボード (テナント mode と役割で表示が変わる)
export default async function DashboardPage() {
  // セッション取得
  const session = await auth();
  // 未ログインなら何も描画しない (middleware 通過後の保険)
  if (!session?.user?.id) return null;

  // ロール判定
  const isAgent = checkIsAgent(session.user.role);
  // セッションから tenantId を取り出して以降の port 呼び出しに伝搬する
  const tenantId = session.user.tenantId;
  // SLA / 期限 判定基準時刻 (現在時刻)
  const now = new Date();
  // テナントの動作モード (lite | pro) を取得し、表示内容を切り替える
  const mode = await getCurrentTenantMode(tenantId);

  // Lite モードのテナントは「自分の未対応 / 期限切れ」の 2 枚タイルだけの簡易版を表示する
  // (Pivot plan §3.1 / §2 ギャップ表: 一人運用では SLA・担当者別の集計は意味が薄いため置換)
  if (mode === 'lite') {
    return (
      <LiteDashboard isAgent={isAgent} userId={session.user.id} tenantId={tenantId} now={now} />
    );
  }

  // 以降は Pro モードの従来ダッシュボード (情シス向けのフル集計)
  // ダッシュボード用 3 指標を 1 メソッドで取得 (内部は groupBy で 3 クエリに集約、tenantId スコープ)
  // - byStatus: 7 状態それぞれの件数 (依頼者なら自身のチケットに限定)
  // - slaOverdue / workload: 当該テナント内全件対象 (表示は呼び出し側で role 制御)
  const stats = await repos.tickets.dashboardStats({
    creatorId: isAgent ? undefined : session.user.id,
    now,
    excludeStatusesForWorkload: ['Resolved', 'Closed'],
    tenantId,
  });

  // SLA 超過件数 (依頼者には表示しないので 0 にしておく)
  const slaOverdueCount = isAgent ? stats.slaOverdue : 0;
  // 担当者別ワークロード (依頼者には表示しないので空配列)
  const workload = isAgent ? stats.workload : [];

  // 表示用に担当者 ID 一覧を抽出 (未割当行は除外)
  const assigneeIds = workload
    .filter((w) => w.assigneeId !== null)
    .map((w) => w.assigneeId as string);

  // 担当者名を解決するため、当該テナント内のユーザー情報をまとめて取得 (port 経由)
  const assigneeNames =
    assigneeIds.length > 0 ? await repos.users.findSummariesByIds(assigneeIds, tenantId) : [];

  // ID → 名前の辞書を作成
  const nameMap = Object.fromEntries(assigneeNames.map((u) => [u.id, u.name]));

  // ステータスカードに表示する順序付き配列 (byStatus からそのまま取り出す)
  const statCards = [
    { status: 'New', count: stats.byStatus.New },
    { status: 'Open', count: stats.byStatus.Open },
    { status: 'WaitingForUser', count: stats.byStatus.WaitingForUser },
    { status: 'InProgress', count: stats.byStatus.InProgress },
    { status: 'Escalated', count: stats.byStatus.Escalated },
    { status: 'Resolved', count: stats.byStatus.Resolved },
  ];

  // SLA 超過カードのトーン (件数 0 はニュートラル、>0 はロゼで強調)
  const slaIsAlert = slaOverdueCount > 0;

  return (
    <div className="space-y-8">
      {/* ページヘッダー: タイトル + サブテキスト */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">ダッシュボード</h1>
        <p className="mt-1 text-sm text-slate-500">
          現在の対応状況と各担当者の負荷を一目で把握できます。
        </p>
      </div>

      {/* ステータス別件数カード群 */}
      <section>
        <h2 className="mb-4 text-xs font-semibold tracking-wider text-slate-500 uppercase">
          ステータス別件数
        </h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
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
                {STATUS_LABELS[card.status]}
              </span>
            </Link>
          ))}
        </div>
      </section>

      {/* SLA 超過件数 (エージェントのみ表示) */}
      {isAgent && (
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

      {/* 担当者別 未完了件数 (エージェントのみ・データがある場合のみ表示) */}
      {isAgent && workload.length > 0 && (
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

// Lite モード用の簡易ダッシュボード (自分の未対応 / 期限切れ の 2 枚タイル)
// Pivot plan §3.1 に対応。一覧タブと同じ条件 (applyTabFilter) で件数を数え、
// タイルをタップすると該当タブの一覧 (/tickets?tab=...) へ遷移する。
async function LiteDashboard({
  isAgent,
  userId,
  tenantId,
  now,
}: {
  isAgent: boolean; // 担当者 (agent/admin) かどうか。'mine' の絞り込み方が依頼者と変わる
  userId: string; // ログインユーザー ID ('mine' で自分の担当/起票を絞る)
  tenantId: string; // テナントスコープ (件数取得に必須)
  now: Date; // 期限超過判定の基準時刻
}) {
  // 件数集計の共通土台。依頼者は自分のチケットのみ、担当者は全件 (creatorId 未指定)
  const baseFilter: TicketListFilter = {
    creatorId: isAgent ? undefined : userId,
  };
  // 一覧タブと同一の条件を再利用して「自分の未対応」「期限切れ」のフィルタを組み立てる
  const mineFilter = applyTabFilter(baseFilter, 'mine', { isAgent, userId, now });
  const overdueFilter = applyTabFilter(baseFilter, 'overdue', { isAgent, userId, now });

  // 2 つの件数を並列に取得 (どちらも tenantId スコープ)
  const [mineCount, overdueCount] = await Promise.all([
    repos.tickets.count(mineFilter, tenantId),
    repos.tickets.count(overdueFilter, tenantId),
  ]);

  return (
    <div className="space-y-8">
      {/* ページヘッダー: タイトル + やさしいサブテキスト (Lite はカタカナ/英語を避ける) */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">ホーム</h1>
        <p className="mt-1 text-sm text-slate-500">
          いま対応が必要な問い合わせをまとめています。タイルを押すと一覧を開けます。
        </p>
      </div>

      {/* 2 枚タイル (スマホでは縦 1 列、sm 以上で 2 列) */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {/* 自分の未対応 (Open / InProgress)。落ち着いたティールで主要導線として強調 */}
        <Link
          href="/tickets?tab=mine"
          className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100 transition duration-200 hover:-translate-y-0.5 hover:shadow-md hover:ring-teal-200"
        >
          <p className="text-sm font-medium text-slate-500">自分の未対応</p>
          <p className="mt-2 text-4xl font-bold text-teal-700">{mineCount}</p>
          <p className="mt-1 text-xs text-slate-400">未対応・対応中の問い合わせ</p>
        </Link>

        {/* 期限切れ。件数 0 はニュートラル、1 件以上はロゼで注意喚起 */}
        <Link
          href="/tickets?tab=overdue"
          className={`rounded-2xl bg-white p-6 shadow-sm ring-1 transition duration-200 hover:-translate-y-0.5 hover:shadow-md ${
            overdueCount > 0
              ? 'ring-rose-200 hover:ring-rose-300'
              : 'ring-slate-100 hover:ring-teal-200'
          }`}
        >
          <p className="text-sm font-medium text-slate-500">期限切れ</p>
          <p
            className={`mt-2 text-4xl font-bold ${overdueCount > 0 ? 'text-rose-700' : 'text-slate-400'}`}
          >
            {overdueCount}
          </p>
          <p className="mt-1 text-xs text-slate-400">期限を過ぎた未完了の問い合わせ</p>
        </Link>
      </div>
    </div>
  );
}
