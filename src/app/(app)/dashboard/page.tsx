// React の Suspense (重い品質指標の読み込みを待たずにページ本体を先に表示するため)
import { Suspense } from 'react';
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
// チュートリアル動画リンクの解決ヘルパー (未設定/不正 URL のときは null)
import { getTutorialVideoUrl } from '@/lib/tutorial-video';
// タブ ('mine' / 'overdue') の絞り込み条件を一元管理する純粋関数 (一覧ページと共有)
import { applyTabFilter } from '@/features/tickets/tab-filter';
// 期限絞り込み ('soon' / 'today') の条件とラベルを一元管理する純粋関数 (一覧ページと共有。
// タイルの件数と drill-down 先の一覧の表示件数を必ず一致させる。監査フォローアップ 2026-09-09)
import { applyDueFilter, DUE_FILTER_LABELS } from '@/features/tickets/due-filter';
// SLA の日本語ラベル・タイル配色・警告帯の閾値 (§6 一元管理: SLA の見せ方は sla.ts が正)
import { SLA_LABELS, SLA_TILE_COLORS, DEFAULT_WARNING_THRESHOLD_MS } from '@/lib/sla';
// 品質指標の取得 (直近 N 日 + 60 秒キャッシュ) と期間定数 (監査フォローアップ 2026-09-09)
import { getCachedQualityMetrics, QUALITY_METRICS_WINDOW_DAYS } from '@/lib/dashboard-metrics';
// 監査で発見したギャップ対応: /tickets への drill-down リンクに選択中の拠点フィルタを
// 引き継ぐための共通ヘルパー (Pro/Lite 両ブランチで共有 / §6 DRY)
import { buildTicketListHref } from '@/features/tickets/dashboard-links';
// データ層が公開しているチケット一覧フィルタ型 (件数取得の引数)
import type { TicketListFilter } from '@/data/ports/ticket-repository';
// 拠点の型 (Phase 4 多拠点。§4.1 フォローアップで Lite ダッシュボードにも拠点フィルタを追加する)
// TicketStatus 型 (statCards の型付けに使う。STATUS_LABELS が Record<TicketStatus, string> に
// なったため、任意の string ではなく実際の TicketStatus であることを明示する必要がある)
import type { Location, TicketStatus } from '@/domain/types';
// §7.1.2 フォローアップ: テナントの実効プラン (Free trial 昇格込み) を解決する共通ヘルパー
import { resolveTenantPlan } from '@/lib/tenant-plan';
// メール取り込みがそのプランで許可されているか (Standard 以上。settings/page.tsx と同じ判定)
import { isEmailInboundAllowed } from '@/lib/plan-guard';
// §7.1.2 フォローアップ: 「はじめかた」ステップをプランに応じて出し分ける純粋ヘルパー
import { buildGettingStartedSteps } from '@/lib/getting-started-steps';
// 監査で発見したギャップ対応: listByTenant は既定で表示用の上限 (LOCATION_LIST_LIMIT = 200) しか
// 返さない。本ページの拠点フィルタは「テナントの全拠点」が前提のため、CSV インポートと同じ
// 網羅的な上限を明示的に渡す (未指定のままだと 201 拠点目以降が選択肢から消える)
import { LOCATION_LIST_MATCHING_LIMIT } from '@/data/ports/location-repository';

// チュートリアルセクションを表示するかどうかの閾値 (テナント全体のチケット件数がこれ未満なら表示)
// 初期サンプルチケット 2 件を含む。小規模なインポート (数件程度) までは表示し続けるため 10 に設定
const TUTORIAL_TICKET_THRESHOLD = 10;

// /dashboard ページの props 型 (URL の検索クエリを受け取る)
interface Props {
  searchParams: Promise<{
    // Phase 4 多拠点: 集計を拠点で絞り込む (未指定は全拠点対象)
    locationId?: string;
  }>;
}

// /dashboard : 集計ダッシュボード (テナント mode と役割で表示が変わる)
export default async function DashboardPage({ searchParams }: Props) {
  // searchParams は Promise なので await して取り出す
  const sp = await searchParams;
  // セッション取得
  const session = await auth();
  // 未ログイン、または tenantId が取得できない場合は何も描画しない。
  // tenantId 欠落のまま進むと Prisma が undefined を「条件なし」として扱い、
  // 全テナントのデータが見える可能性があるため早期に弾く (§9 セキュリティ / クロステナント漏洩防止)
  if (!session?.user?.id || !session.user.tenantId) return null;

  // ロール判定
  const isAgent = checkIsAgent(session.user.role);
  // セッションから tenantId を取り出して以降の port 呼び出しに伝搬する。
  // 上の null チェックを通過しているため tenantId は string として確定している
  const tenantId: string = session.user.tenantId;
  // SLA / 期限 判定基準時刻 (現在時刻)
  const now = new Date();
  // テナントの動作モード (lite | pro) を取得し、表示内容を切り替える
  const mode = await getCurrentTenantMode(tenantId);

  // Lite モードのテナントは「自分の未対応 / 期限切れ」の 2 枚タイルだけの簡易版を表示する
  // (Pivot plan §3.1 / §2 ギャップ表: 一人運用では SLA・担当者別の集計は意味が薄いため置換)
  if (mode === 'lite') {
    // Phase 3 オンボーディング: エージェント向けにチュートリアルセクションを表示する
    // チケット総数が閾値未満のテナントに限定して表示する (使い始め期間のみ案内する)
    const totalTickets = isAgent ? await repos.tickets.count({}, tenantId) : 0;
    // §4.1 フォローアップ: 多店舗テナントは Pro ダッシュボードと同様に拠点で絞り込めるようにする
    // (Lite は既定モードであり、多拠点の SMB が最も多くこの画面を使うため Pro 限定のままでは
    // §4.1 で埋めたはずのギャップが Lite テナントに対しては残ってしまう)
    const locations = await repos.locations.listByTenant(tenantId, {
      limit: LOCATION_LIST_MATCHING_LIMIT,
    });
    // URL の locationId は当該テナントの拠点一覧に実在するものだけを有効とみなす (Pro 側と同じ検証)
    const selectedLocationId = resolveSelectedLocationId(sp.locationId, locations);
    // チュートリアルを表示する条件 (エージェントかつチケット件数が閾値未満)
    const showTutorial = isAgent && totalTickets < TUTORIAL_TICKET_THRESHOLD;
    // §7.1.2 フォローアップ: チュートリアルを表示する場合のみ実効プランを解決し、
    // メール転送ステップの出し分けに使う (表示しないテナントでは無駄な解決をしない)。
    // resolveTenantPlan は getCachedTenant 経由でリクエストスコープのメモ化が効くため、
    // 同一リクエスト内の他箇所 (layout.tsx 等) で既に解決済みなら追加の SELECT は発生しない
    const gettingStartedSteps = showTutorial
      ? buildGettingStartedSteps(isEmailInboundAllowed(await resolveTenantPlan(tenantId)))
      : [];
    return (
      <LiteDashboard
        isAgent={isAgent}
        userId={session.user.id}
        tenantId={tenantId}
        now={now}
        showTutorial={showTutorial}
        locations={locations}
        selectedLocationId={selectedLocationId}
        gettingStartedSteps={gettingStartedSteps}
      />
    );
  }

  // 以降は Pro モードの従来ダッシュボード (情シス向けのフル集計)
  // Phase 4 多拠点: テナントの拠点一覧を取得する (フィルタ UI の表示要否・選択肢に使う)。
  // Lite 側と同じ理由で網羅的な上限を明示する
  const locations = await repos.locations.listByTenant(tenantId, {
    limit: LOCATION_LIST_MATCHING_LIMIT,
  });
  // URL の locationId は当該テナントの拠点一覧に実在するものだけを有効とみなす
  const selectedLocationId = resolveSelectedLocationId(sp.locationId, locations);

  // ダッシュボード用の集計を並列取得する
  // - byStatus: 7 状態それぞれの件数 (依頼者なら自身のチケットに限定)
  // - slaOverdue / workload: 当該テナント内全件対象 (表示は呼び出し側で role 制御)
  // - dueSoonCount: 期限間近 (SLA 警告帯) の件数。タイルの drill-down 先 (?due=soon の一覧) と
  //   同じ applyDueFilter を通し、件数と一覧の表示件数を必ず一致させる (監査フォローアップ 2026-09-09)
  // ※ 品質指標 (対応品質) はこの Promise.all に含めない。最も重い集計のため、下の
  //   Suspense 境界 (QualityMetricsSection) へ分離してページ本体の表示をブロックしないようにする
  const [stats, dueSoonCount] = await Promise.all([
    // チケット集計 (byStatus / slaOverdue / workload) を取得する
    repos.tickets.dashboardStats({
      // 依頼者は自分が起票したチケットのみ集計する (RBAC)
      creatorId: isAgent ? undefined : session.user.id,
      // SLA 期限判定の基準時刻
      now,
      // ワークロード集計で完了済みを除外するステータス一覧
      excludeStatusesForWorkload: ['Resolved', 'Closed'],
      // テナントスコープ (クロステナント漏洩防止)
      tenantId,
      // 拠点フィルタ (選択されていれば当該拠点のみ集計)
      locationId: selectedLocationId,
    }),
    // 期限間近件数はエージェントにのみ表示するため、依頼者では取得自体を省略する
    isAgent
      ? repos.tickets.count(
          // 拠点フィルタ付きの base に「期限間近」条件を重ねる (一覧の ?due=soon と同一条件)
          applyDueFilter({ locationId: selectedLocationId }, 'soon', { now }),
          tenantId,
        )
      : Promise.resolve(0),
  ]);

  // SLA 超過件数 (依頼者には表示しないので 0 にしておく)
  const slaOverdueCount = isAgent ? stats.slaOverdue : 0;
  // 担当者別ワークロード (依頼者には表示しないので空配列)
  const workload = isAgent ? stats.workload : [];

  // 表示用に担当者 ID 一覧を抽出 (未割当行は除外)。
  // TypeScript は .filter() 後の null 除外を自動的に型に反映しないため、
  // flatMap で「null なら空配列、string なら 1 要素配列」に変換して型安全に string[] を得る。
  const assigneeIds = workload.flatMap((w) => (w.assigneeId !== null ? [w.assigneeId] : []));

  // 担当者名を解決するため、当該テナント内のユーザー情報をまとめて取得 (port 経由)
  const assigneeNames =
    assigneeIds.length > 0 ? await repos.users.findSummariesByIds(assigneeIds, tenantId) : [];

  // ID → 名前の辞書を作成
  const nameMap = Object.fromEntries(assigneeNames.map((u) => [u.id, u.name]));

  // ステータスカードに表示する順序付き配列 (byStatus からそのまま取り出す)
  // status を TicketStatus 型で明示し、STATUS_LABELS[card.status] の型安全な参照を保つ
  // フォローアップ (2026-07-11 #3): 「Closed」が抜けており、TicketRepository.dashboardStats が
  // 集計している 7 状態のうち 1 状態が画面に一切表示されていなかった (下の Closed カードを参照)
  const statCards: { status: TicketStatus; count: number }[] = [
    { status: 'New', count: stats.byStatus.New },
    { status: 'Open', count: stats.byStatus.Open },
    { status: 'WaitingForUser', count: stats.byStatus.WaitingForUser },
    { status: 'InProgress', count: stats.byStatus.InProgress },
    { status: 'Escalated', count: stats.byStatus.Escalated },
    { status: 'Resolved', count: stats.byStatus.Resolved },
    // フォローアップ (2026-07-11 #3): Resolved とは別の独立した終了状態のため追加する
    // (ALLOWED_TRANSITIONS 上はどの状態からも直接 Closed へ遷移可能で、Resolved の別名ではない)
    { status: 'Closed', count: stats.byStatus.Closed },
  ];

  // ワークロードの最大件数 (負荷バーの長さを最大値比で描くための分母。0 除算は max で回避)
  const workloadMax = Math.max(1, ...workload.map((row) => row.count));

  return (
    <div className="space-y-8">
      {/* ページヘッダー: タイトル + サブテキスト (ロールに合わせて説明を変える。
          依頼者には表示されない「担当者別の負荷」を約束する文言を見せない) */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">ダッシュボード</h1>
        <p className="mt-1 text-sm text-slate-500">
          {isAgent
            ? '現在の対応状況と各担当者の負荷を一目で把握できます。'
            : 'あなたの問い合わせの状況をまとめています。カードを押すと一覧を開けます。'}
        </p>
      </div>

      {/* Phase 4 多拠点: 拠点フィルタ (拠点が 1 つも登録されていないテナントには表示しない) */}
      <LocationFilterPills locations={locations} selectedLocationId={selectedLocationId} />

      {/* ステータス別件数カード群 (見出しとセクションを aria-labelledby で関連づけ、
          支援技術がランドマーク単位で読み飛ばせるようにする §7) */}
      <section aria-labelledby="dashboard-status-heading">
        <h2
          id="dashboard-status-heading"
          className="mb-4 text-xs font-semibold tracking-wider text-slate-500 uppercase"
        >
          ステータス別件数
        </h2>
        {/* フォローアップ (2026-07-11 #3): statCards が 6→7 件になったため sm:4 / lg:7 列に調整 */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-7">
          {statCards.map((card) => (
            // カードクリックで該当ステータスのフィルタ済み一覧へ遷移。
            // 監査で発見したギャップ対応: 選択中の拠点フィルタも引き継ぐ (でないと遷移先で
            // 「全拠点」に戻り、カードで見た件数と一覧の表示件数が食い違う)
            <Link
              key={card.status}
              href={buildTicketListHref(`status=${card.status}`, selectedLocationId)}
              // 読み上げでは「2 新規」だけだとリンク先が伝わらないため、
              // 件数 + 遷移先 (一覧) をまとめたアクセシブルネームを与える (§7)
              aria-label={`${STATUS_LABELS[card.status]} ${card.count} 件の一覧を見る`}
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

      {/* 対応期限 (SLA) セクション (エージェントのみ表示)。
          監査フォローアップ (2026-09-09): 以前は「超過してから数える」事後の 1 タイルだけで、
          しかもページ内で唯一クリックできない数字だった。SLA 運用の定石 (超過前に警告する) に
          合わせて「期限間近」(警告帯) を並置し、両方とも該当一覧へ drill-down できるようにする */}
      {isAgent && (
        <section aria-labelledby="dashboard-sla-heading">
          <h2
            id="dashboard-sla-heading"
            className="mb-4 text-xs font-semibold tracking-wider text-slate-500 uppercase"
          >
            対応期限（SLA）
          </h2>
          {/* 期限超過 / 期限間近 の 2 タイル (他セクションと同じグリッドで幅も揃える) */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {/* 期限超過: いま SLA を破っている件数。一覧の「期限切れ」タブと同一条件 */}
            <SlaTile
              label={SLA_LABELS.overdue}
              count={slaOverdueCount}
              tone="overdue"
              description="期限を過ぎた未解決の問い合わせ"
              href={buildTicketListHref('tab=overdue', selectedLocationId)}
            />
            {/* 期限間近: これから SLA を破りそうな件数 (警告帯)。?due=soon の一覧と同一条件。
                説明の残り時間は sla.ts の警告帯閾値から導出する (§6 値の書き写し禁止) */}
            <SlaTile
              label={SLA_LABELS.warning}
              count={dueSoonCount}
              tone="warning"
              description={`残り ${DEFAULT_WARNING_THRESHOLD_MS / (60 * 60 * 1000)} 時間以内に期限が来る問い合わせ`}
              href={buildTicketListHref('due=soon', selectedLocationId)}
            />
          </div>
        </section>
      )}

      {/* 担当者別 未完了件数 (エージェントのみ・データがある場合のみ表示) */}
      {isAgent && workload.length > 0 && (
        <section aria-labelledby="dashboard-workload-heading">
          <h2
            id="dashboard-workload-heading"
            className="mb-4 text-xs font-semibold tracking-wider text-slate-500 uppercase"
          >
            担当者別 未完了件数
          </h2>
          {/* 外側は角丸のカード、内側に横スクロール領域を持たせる
              (monitor 幅の狭い端末で「一覧を見る」列がはみ出して押せなくなるのを防ぐ) */}
          <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-100">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-100 text-sm">
                <thead className="bg-slate-50/80">
                  <tr>
                    <th className="px-5 py-3 text-left text-[11px] font-semibold tracking-wider text-slate-500 uppercase">
                      担当者
                    </th>
                    <th className="px-5 py-3 text-right text-[11px] font-semibold tracking-wider text-slate-500 uppercase">
                      件数
                    </th>
                    <th className="px-5 py-3 text-right text-[11px] font-semibold tracking-wider text-slate-500 uppercase">
                      {/* 操作列の見出し。視覚上は空欄のままにし、読み上げにだけ列名を伝える (§7) */}
                      <span className="sr-only">操作</span>
                    </th>
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
                        <td className="px-5 py-3.5 text-slate-700">
                          {/* 担当者名 */}
                          {name}
                          {/* 負荷バー: 最大件数を 100% とした相対量を面で示し、
                              数字を読み比べなくても偏りが一目で分かるようにする。
                              実数値は隣の「件数」セルが持つため、バー自体は装飾として
                              読み上げ対象から外す (§7 色や図形だけに意味を持たせない) */}
                          <div
                            className="mt-1.5 h-1.5 w-full max-w-48 rounded-full bg-slate-100"
                            aria-hidden="true"
                          >
                            <div
                              className="h-1.5 rounded-full bg-teal-600"
                              style={{ width: `${Math.round((row.count / workloadMax) * 100)}%` }}
                            />
                          </div>
                        </td>
                        <td className="px-5 py-3.5 text-right font-semibold text-slate-900">
                          {row.count}
                        </td>
                        <td className="px-5 py-3.5 text-right">
                          {/* 監査で発見したギャップ対応: 選択中の拠点フィルタも引き継ぐ。
                              リンク名は行ごとに一意にする (全行「一覧を見る」だと読み上げ・
                              音声操作でリンクを区別できない §7)。
                              **見えている文字列「一覧を見る」をそのまま含む形にする** —
                              音声操作 (Voice Control 等) は見えている文字を読み上げて操作するため、
                              「一覧で見る」のように 1 文字でも変えるとリンクを起動できなくなる
                              (WCAG 2.5.3 Label in Name)。他のタイルの aria-label も同じ規則 */}
                          <Link
                            href={buildTicketListHref(query, selectedLocationId)}
                            aria-label={`${name} の未完了 ${row.count} 件の一覧を見る`}
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
          </div>
        </section>
      )}

      {/* 品質メトリクス (エージェントのみ。issue-backlog #25)。
          監査フォローアップ (2026-09-09): このページで最も重い 3 本の集計クエリが
          ページ全体の初期表示をブロックしていたため、Suspense 境界で分離して
          カード群を先に描画し、このセクションだけ後から流し込む (§8 表示を止めない)。
          集計期間も全期間 → 直近 QUALITY_METRICS_WINDOW_DAYS 日の移動窓に変更した
          (全期間の累積平均はデータが増えるほど動かなくなり、指標として機能しないため) */}
      {isAgent && (
        <section aria-labelledby="dashboard-quality-heading">
          <h2
            id="dashboard-quality-heading"
            className="mb-4 text-xs font-semibold tracking-wider text-slate-500 uppercase"
          >
            対応品質
            {/* 集計期間の明示 (期間の分からない平均値は解釈できないため必ず添える)。
                値は dashboard-metrics.ts の定数から導出する (§6 値の書き写し禁止) */}
            <span className="ml-2 font-normal tracking-normal text-slate-400">
              （直近 {QUALITY_METRICS_WINDOW_DAYS} 日）
            </span>
          </h2>
          {/* 読み込み中はタイルと同形のスケルトンを出し、後から数値に差し替わっても
              レイアウトが動かないようにする (§8 CLS を悪化させない) */}
          <Suspense fallback={<QualityMetricsSkeleton />}>
            <QualityMetricsSection tenantId={tenantId} locationId={selectedLocationId} now={now} />
          </Suspense>
        </section>
      )}
    </div>
  );
}

// 対応期限 (SLA) セクションのタイル 1 枚分。件数 0 はニュートラル、1 件以上は tone の警告色。
// 全タイルを Link にし、押すと同一条件で絞り込んだ一覧へ遷移する (数字の根拠に必ず到達できる)
function SlaTile({
  label,
  count,
  tone,
  description,
  href,
}: {
  label: string; // タイルの見出し (SLA_LABELS 由来。例: 期限超過 / 期限間近)
  count: number; // 表示する件数
  tone: 'warning' | 'overdue'; // 1 件以上のときに使う警告トーン (配色は sla.ts が正)
  description: string; // 件数の意味を説明する短文 (専門用語の言い換え)
  href: string; // drill-down 先の一覧 URL (件数と同一条件)
}) {
  // 1 件以上なら警告トーン、0 件ならニュートラルな見た目にする
  const isAlert = count > 0;
  // tone に応じたタイル配色を sla.ts の一元管理から引く
  const colors = SLA_TILE_COLORS[tone];
  return (
    <Link
      href={href}
      // 読み上げ用に「何の件数で、押すとどこへ行くか」をまとめて伝える (§7)
      aria-label={`${label} ${count} 件の一覧を見る`}
      className={`rounded-2xl bg-white p-5 shadow-sm ring-1 transition duration-200 hover:-translate-y-0.5 hover:shadow-md ${
        isAlert ? colors.container : 'ring-slate-100 hover:ring-teal-200'
      }`}
    >
      {/* 件数 (0 件は薄いグレーで「問題なし」を伝える) */}
      <p className={`text-3xl font-bold ${isAlert ? colors.number : 'text-slate-400'}`}>{count}</p>
      {/* タイルの見出し */}
      <p className="mt-2 text-sm font-medium text-slate-700">{label}</p>
      {/* 件数の意味の説明 */}
      <p className="mt-1 text-xs text-slate-500">{description}</p>
    </Link>
  );
}

// 対応品質セクションの本体 (Suspense 境界の内側で遅延描画される非同期 Server Component)。
// 直近 QUALITY_METRICS_WINDOW_DAYS 日の品質指標を 60 秒キャッシュ付きで取得して表示する
async function QualityMetricsSection({
  tenantId,
  locationId,
  now,
}: {
  tenantId: string; // テナントスコープ (クロステナント漏洩防止に必須)
  locationId: string | undefined; // 拠点フィルタ (未選択は undefined = 全拠点)
  now: Date; // 現在時刻 (集計期間の起点計算に使う)
}) {
  // 品質指標を取得する (期間・キャッシュの方針は dashboard-metrics.ts に集約)
  const metrics = await getCachedQualityMetrics(tenantId, locationId, now);
  // 3 指標がすべて null のときはデータ不足を明示する
  // 各指標はそれぞれ独立した分母を持つため、個別の null チェックで表示を制御する
  if (
    metrics.avgFirstResponseMs == null &&
    metrics.avgResolutionMs == null &&
    metrics.reopenRate == null
  ) {
    return (
      <p className="text-sm text-slate-400">対応済みのチケットが蓄積されると指標が表示されます。</p>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {/* 平均初回応答時間 (分母: 初回応答済みチケット数) */}
      <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100">
        <p className="text-2xl font-bold text-slate-900">
          {metrics.avgFirstResponseMs != null ? (
            formatDurationMs(metrics.avgFirstResponseMs)
          ) : (
            <MetricUnavailable />
          )}
        </p>
        <p className="mt-1 text-xs text-slate-500">平均初回応答時間</p>
      </div>
      {/* 平均解決時間 (分母: resolvedCount = 解決済みチケット数) */}
      <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100">
        <p className="text-2xl font-bold text-slate-900">
          {metrics.avgResolutionMs != null ? (
            formatDurationMs(metrics.avgResolutionMs)
          ) : (
            <MetricUnavailable />
          )}
        </p>
        <p className="mt-1 text-xs text-slate-500">平均解決時間</p>
      </div>
      {/* 再オープン率 (分母: totalCount = 窓の中で対応を終えた件数。全チケット数ではない) */}
      <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100">
        <p className="text-2xl font-bold text-slate-900">
          {metrics.reopenRate != null ? (
            `${Math.round(metrics.reopenRate * 100)} %`
          ) : (
            <MetricUnavailable />
          )}
        </p>
        <p className="mt-1 text-xs text-slate-500">
          再オープン率{' '}
          {/* 分母ラベルは再オープン率が実際に計算されたときだけ表示する。
              null (データ不足) の場合は「—」と並べて件数を出すと誤解を招くため非表示にする。
              分母は「全チケット」ではなく「この期間に一度対応が区切られた件数」
              (窓内で解決した ∪ 窓内で差し戻された) なので、そう読める文言にする:
              - 「全 N 件中」だと未対応のチケットまで含む数字だと誤読される
              - 「対応を終えた N 件中」だと、差し戻されていま未対応に戻っているチケットが
                分母に入っていることを説明できない (/code-review ultra 指摘対応 2026-09-10) */}
          {metrics.reopenRate != null && (
            <span className="text-slate-400">
              (対応が一区切りついた {metrics.totalCount} 件中)
            </span>
          )}
        </p>
      </div>
    </div>
  );
}

// 指標が計算できない (データ不足) ことを示す表示。
// 見た目は従来どおりダッシュ「—」だが、読み上げには「データ不足」と意味を伝える (§7)
function MetricUnavailable() {
  return (
    <>
      {/* 視覚向けのダッシュ (読み上げからは除外する) */}
      <span aria-hidden="true">—</span>
      {/* 読み上げ専用の説明 */}
      <span className="sr-only">データ不足のため表示できません</span>
    </>
  );
}

// 対応品質セクションの読み込み中スケルトン (タイル 3 枚と同じ形・同じ高さで場所を確保する)
function QualityMetricsSkeleton() {
  return (
    // role=status + 読み上げ用テキストで「読み込み中」であることを支援技術にも伝える
    <div role="status" className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {/* 読み上げ専用の状態説明 */}
      <span className="sr-only">対応品質を読み込み中</span>
      {/* タイルと同形のプレースホルダを 3 枚並べる (差し替え時のレイアウトシフト防止) */}
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100">
          {/* 数値部分のプレースホルダ (motion-safe: reduced-motion 環境では点滅させない §7) */}
          <div className="h-8 w-24 rounded bg-slate-100 motion-safe:animate-pulse" />
          {/* ラベル部分のプレースホルダ */}
          <div className="mt-2 h-4 w-32 rounded bg-slate-100 motion-safe:animate-pulse" />
        </div>
      ))}
    </div>
  );
}

// URL の locationId が当該テナントの拠点一覧に実在するものかどうかを検証する共有ヘルパー。
// (存在しない ID や他テナントの ID をそのまま渡しても集計スコープは tenantId が守るため危険は
// ないが、UI 上「フィルタが効いていないのに URL だけ残る」事故を避けるため検証する)
// /code-review ultra 指摘対応: LocationFilterPills と同様、Pro/Lite 両ブランチで書き写して
// いた同一のバリデーション三項演算子を 1 箇所に集約する (§6 DRY)。
function resolveSelectedLocationId(
  rawLocationId: string | undefined, // URL クエリの生値 (未指定なら undefined)
  locations: Location[], // テナントの拠点一覧 (実在確認に使う)
): string | undefined {
  // 生値が空、または一覧に存在しない ID なら「フィルタなし」扱いにする
  return rawLocationId && locations.some((l) => l.id === rawLocationId) ? rawLocationId : undefined;
}

// 拠点フィルタのピル UI (Pro / Lite 両ダッシュボードで共有)。
// §4.1 フォローアップでは Pro ダッシュボード専用の実装だったが、Lite (既定モード) の
// ダッシュボードにも同じ UI を使うため 1 箇所に集約する (§6 DRY: 2 箇所目の複製が
// 必要になった時点で共通化する方針に従う)。
function LocationFilterPills({
  locations,
  selectedLocationId,
}: {
  locations: Location[]; // テナントの拠点一覧 (空なら何も描画しない)
  selectedLocationId: string | undefined; // 現在選択中の拠点 ID (未選択は undefined)
}) {
  // 拠点が 1 つも登録されていないテナントには表示しない
  if (locations.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold tracking-wider text-slate-500 uppercase">
        拠点で絞り込み
      </span>
      {/* 「すべての拠点」ピル (未選択状態)。選択状態は色だけでなく aria-current と
          チェックマークでも伝える (§7 a11y「色だけに意味を持たせない」) */}
      <Link
        href="/dashboard"
        aria-current={selectedLocationId === undefined ? 'true' : undefined}
        className={`rounded-full px-3 py-1 text-xs font-medium transition ${
          selectedLocationId === undefined
            ? 'bg-teal-700 text-white'
            : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'
        }`}
      >
        {selectedLocationId === undefined && <span aria-hidden="true">✓ </span>}
        すべての拠点
      </Link>
      {/* 拠点ごとのピル (同様に aria-current + チェックマークで選択状態を明示) */}
      {locations.map((location) => (
        <Link
          key={location.id}
          href={`/dashboard?locationId=${location.id}`}
          aria-current={selectedLocationId === location.id ? 'true' : undefined}
          className={`rounded-full px-3 py-1 text-xs font-medium transition ${
            selectedLocationId === location.id
              ? 'bg-teal-700 text-white'
              : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'
          }`}
        >
          {selectedLocationId === location.id && <span aria-hidden="true">✓ </span>}
          {location.name}
        </Link>
      ))}
    </div>
  );
}

/**
 * ミリ秒を「X 日 Y 時間」または「Y 時間 Z 分」という日本語の所要時間文字列に変換する。
 * ダッシュボードの品質メトリクスカードに使用する (issue-backlog #25)。
 * 30 秒未満 (四捨五入で 0 分) は「< 1 分」と表示し、null 渡しは呼び出し元で処理する。
 */
function formatDurationMs(ms: number): string {
  // NaN は Math.max(0, NaN) === NaN になるため、先に有限数かどうかを確認する。
  // DB から Decimal オブジェクトが返り Number() 変換後に NaN になるケースへの保護。
  if (!Number.isFinite(ms)) return '—';
  // 負値は丸めて 0 扱いにする (データ異常の保護)
  const totalMs = Math.max(0, ms);
  // ミリ秒 → 分に変換する
  const totalMinutes = Math.round(totalMs / 60_000);
  // 1 日以上の場合は「X 日 Y 時間」形式で返す
  if (totalMinutes >= 60 * 24) {
    const days = Math.floor(totalMinutes / (60 * 24)); // 日数
    const hours = Math.floor((totalMinutes % (60 * 24)) / 60); // 余り時間
    return hours > 0 ? `${days} 日 ${hours} 時間` : `${days} 日`;
  }
  // 1 時間以上の場合は「X 時間 Y 分」形式で返す
  if (totalMinutes >= 60) {
    const hours = Math.floor(totalMinutes / 60); // 時間
    const minutes = totalMinutes % 60; // 余り分
    return minutes > 0 ? `${hours} 時間 ${minutes} 分` : `${hours} 時間`;
  }
  // 1 分未満 (30 秒未満で四捨五入が 0 になる場合) は「< 1 分」と表示する。
  // 「0 分」は平均が 0 の場合と見分けがつかず、速い応答チームに誤解を与えるため使わない。
  if (totalMinutes === 0) return '< 1 分';
  // 1 時間未満は「X 分」形式で返す
  return `${totalMinutes} 分`;
}

// Lite モード用の簡易ダッシュボード (自分の未対応 / 期限切れ の 2 枚タイル + チュートリアル)
// Pivot plan §3.1 に対応。一覧タブと同じ条件 (applyTabFilter) で件数を数え、
// タイルをタップすると該当タブの一覧 (/tickets?tab=...) へ遷移する。
async function LiteDashboard({
  isAgent,
  userId,
  tenantId,
  now,
  showTutorial,
  locations,
  selectedLocationId,
  gettingStartedSteps,
}: {
  isAgent: boolean; // 担当者 (agent/admin) かどうか。'mine' の絞り込み方が依頼者と変わる
  userId: string; // ログインユーザー ID ('mine' で自分の担当/起票を絞る)
  tenantId: string; // テナントスコープ (件数取得に必須)
  now: Date; // 期限超過判定の基準時刻
  showTutorial: boolean; // Phase 3: チュートリアルセクションを表示するかどうか
  locations: Location[]; // §4.1 フォローアップ: テナントの拠点一覧 (拠点フィルタ UI の表示要否・選択肢)
  selectedLocationId: string | undefined; // 選択中の拠点 ID (未選択は undefined = 全拠点)
  // §7.1.2 フォローアップ: プランに応じて出し分け済みの「はじめかた」ステップ一覧
  // (showTutorial=false のときは呼び出し元から空配列が渡る)
  gettingStartedSteps: ReturnType<typeof buildGettingStartedSteps>;
}) {
  // 件数集計の共通土台。依頼者は自分のチケットのみ、担当者は全件 (creatorId 未指定)。
  // §4.1 フォローアップ: 拠点フィルタも Pro ダッシュボードと同様にここへ差し込む
  const baseFilter: TicketListFilter = {
    creatorId: isAgent ? undefined : userId,
    locationId: selectedLocationId,
  };
  // 一覧と同一の条件を再利用して 2 タイルのフィルタを組み立てる。
  // 「自分の未対応」は一覧の 'mine' タブと同じ条件。
  // 2 枚目は Pivot plan §3.1 の正本仕様どおり **「期限切れ・今日まで」** (期限超過 + 今日が期限)。
  // 監査フォローアップ (2026-09-09): 従来は厳密な期限超過 ('overdue' タブ) だけを数えており、
  // 「今日中に対応すべきもの」が正本仕様に反して見えていなかった。?due=today の一覧と
  // 同じ applyDueFilter を通し、タイルの件数と遷移先の表示件数を一致させる
  const mineFilter = applyTabFilter(baseFilter, 'mine', { isAgent, userId, now });
  const dueTodayFilter = applyDueFilter(baseFilter, 'today', { now });

  // 2 つの件数を並列に取得 (どちらも tenantId スコープ)
  const [mineCount, dueTodayCount] = await Promise.all([
    repos.tickets.count(mineFilter, tenantId),
    repos.tickets.count(dueTodayFilter, tenantId),
  ]);
  // チュートリアル動画リンク (未設定ならセクション自体を出さないため showTutorial のときだけ解決する)
  const tutorialVideoUrl = showTutorial ? getTutorialVideoUrl() : null;

  return (
    <div className="space-y-8">
      {/* ページヘッダー: タイトル + やさしいサブテキスト (Lite はカタカナ/英語を避ける) */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">ホーム</h1>
        <p className="mt-1 text-sm text-slate-500">
          いま対応が必要な問い合わせをまとめています。タイルを押すと一覧を開けます。
        </p>
      </div>

      {/* §4.1 フォローアップ: 多店舗テナント向けの拠点フィルタ (拠点未登録なら何も表示しない) */}
      <LocationFilterPills locations={locations} selectedLocationId={selectedLocationId} />

      {/* 2 枚タイル (スマホでは縦 1 列、sm 以上で 2 列) */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {/* 自分の未対応 (Open / InProgress)。落ち着いたティールで主要導線として強調。
            監査で発見したギャップ対応: 選択中の拠点フィルタも引き継ぐ */}
        <Link
          href={buildTicketListHref('tab=mine', selectedLocationId)}
          // 読み上げでは件数と遷移先をまとめて伝える (§7)
          aria-label={`自分の未対応 ${mineCount} 件の一覧を見る`}
          className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100 transition duration-200 hover:-translate-y-0.5 hover:shadow-md hover:ring-teal-200"
        >
          <p className="text-sm font-medium text-slate-500">自分の未対応</p>
          <p className="mt-2 text-4xl font-bold text-teal-700">{mineCount}</p>
          <p className="mt-1 text-xs text-slate-400">未対応・対応中の問い合わせ</p>
        </Link>

        {/* 期限切れ・今日まで (Pivot plan §3.1 の正本仕様)。件数 0 はニュートラル、
            1 件以上は期限超過トーンで注意喚起。ラベルは一覧の絞り込みチップと同じ
            DUE_FILTER_LABELS を参照する (§6 一元管理)。監査で発見したギャップ対応:
            選択中の拠点フィルタも引き継ぐ。
            /code-review ultra 指摘対応 (2026-09-10): 配色を rose 直書きから
            SLA_TILE_COLORS.overdue の参照に変えた。直書きのままだと、この PR が
            sla.ts へ一元化したはずの警告色がここだけ 2 つ目の真実の源として残り、
            パレット変更のたびに 2 か所を直す必要が出る (§6 配色の一元管理)。
            SlaTile コンポーネント自体は再利用しない — Lite の 2 枚タイルは隣の
            「自分の未対応」と同じ大きさ (p-6 / text-4xl) で対になっているのに対し、
            SlaTile は Pro の 3 列グリッド向けの一回り小さい寸法 (p-5 / text-3xl) で、
            共有すると Lite の 2 枚だけ大きさが食い違うため。共有するのは配色だけでよい */}
        <Link
          href={buildTicketListHref('due=today', selectedLocationId)}
          // 読み上げでは件数と遷移先をまとめて伝える (§7)
          aria-label={`${DUE_FILTER_LABELS.today} ${dueTodayCount} 件の一覧を見る`}
          className={`rounded-2xl bg-white p-6 shadow-sm ring-1 transition duration-200 hover:-translate-y-0.5 hover:shadow-md ${
            dueTodayCount > 0
              ? SLA_TILE_COLORS.overdue.container
              : 'ring-slate-100 hover:ring-teal-200'
          }`}
        >
          <p className="text-sm font-medium text-slate-500">{DUE_FILTER_LABELS.today}</p>
          <p
            className={`mt-2 text-4xl font-bold ${dueTodayCount > 0 ? SLA_TILE_COLORS.overdue.number : 'text-slate-400'}`}
          >
            {dueTodayCount}
          </p>
          <p className="mt-1 text-xs text-slate-400">期限を過ぎた・今日が期限の未完了の問い合わせ</p>
        </Link>
      </div>

      {/* Phase 3 チュートリアルセクション: 使い始め期間のエージェントにだけ表示する */}
      {/* チケット件数が閾値を超えたら自動的に非表示になる (操作に慣れた後は邪魔にならないよう) */}
      {showTutorial && (
        <section>
          {/* セクションタイトル */}
          <h2 className="mb-4 text-xs font-semibold tracking-wider text-slate-500 uppercase">
            はじめかた
          </h2>
          {/* ステップカード列 (スマホ縦積み → sm 以上で 3 列) */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {gettingStartedSteps.map(({ step, title, description, href }) =>
              // ステップカード: リンクがあればクリッカブルに、なければ静的カードにする
              href ? (
                <Link
                  key={step}
                  href={href}
                  className="rounded-2xl bg-slate-50 p-5 ring-1 ring-slate-200 transition duration-200 hover:bg-teal-50 hover:ring-teal-200"
                >
                  {/* ステップ番号バッジ */}
                  <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-teal-100 text-xs font-bold text-teal-700">
                    {step}
                  </span>
                  {/* ステップのタイトル */}
                  <p className="mt-2 text-sm font-semibold text-slate-800">{title}</p>
                  {/* ステップの補足説明 */}
                  <p className="mt-1 text-xs text-slate-500">{description}</p>
                </Link>
              ) : (
                <div key={step} className="rounded-2xl bg-slate-50 p-5 ring-1 ring-slate-200">
                  {/* ステップ番号バッジ (リンクなし版) */}
                  <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-teal-100 text-xs font-bold text-teal-700">
                    {step}
                  </span>
                  {/* ステップのタイトル */}
                  <p className="mt-2 text-sm font-semibold text-slate-800">{title}</p>
                  {/* ステップの補足説明 */}
                  <p className="mt-1 text-xs text-slate-500">{description}</p>
                </div>
              ),
            )}
          </div>
          {/* チュートリアルガイドへの誘導 (ヘルプセンターの 30 分スタートガイドを案内する) */}
          <p className="mt-3 text-xs text-slate-400">
            詳しい手順は
            <Link
              href="/help/getting-started"
              className="mx-1 text-teal-700 underline hover:text-teal-800"
            >
              30 分で運用開始するガイド
            </Link>
            をご覧ください。
          </p>
          {/* チュートリアル動画へのリンク (TUTORIAL_VIDEO_URL 未設定の間は表示しない) */}
          {tutorialVideoUrl && (
            <p className="mt-1 text-xs text-slate-400">
              文章より映像で確認したい方はこちら。
              {/* 外部動画のため新しいタブで開き、rel でタブナビゲーション経由の攻撃を防ぐ (§7 a11y) */}
              <a
                href={tutorialVideoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-1 text-teal-700 underline hover:text-teal-800"
              >
                チュートリアル動画を見る
              </a>
            </p>
          )}
          {/* 問い合わせ一覧のサンプルチケットへのリンク (操作確認を促す) */}
          <p className="mt-1 text-xs text-slate-400">
            問い合わせ一覧にサンプルの問い合わせが 2 件入っています。
            <Link href="/tickets" className="ml-1 text-teal-700 underline hover:text-teal-800">
              一覧を見る
            </Link>
          </p>
        </section>
      )}
    </div>
  );
}
