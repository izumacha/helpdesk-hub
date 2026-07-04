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
// データ層が公開しているチケット一覧フィルタ型 (件数取得の引数)
import type { TicketListFilter } from '@/data/ports/ticket-repository';

// チュートリアルセクションに表示する「はじめかた」ステップ一覧 (Phase 3 オンボーディング)。
// 3 ステップ固定。変更が必要なら以下の配列を直接編集する (各所に散らさない §6 定数の一元管理)。
const GETTING_STARTED_STEPS = [
  {
    step: 1, // ステップ番号 (表示用)
    title: 'スタッフを招待する', // ステップのタイトル
    description: '設定画面の「招待リンク発行」からメンバーを招待しましょう。', // 補足説明
    href: '/settings/invite', // 誘導先のリンク (ない場合は null)
  },
  {
    step: 2,
    title: 'メールの転送アドレスを設定する',
    description:
      '設定画面に専用の転送アドレスが表示されます。Gmail や Outlook の自動転送を設定すると、メールが届くたびに自動で問い合わせが作成されます。',
    href: '/settings',
  },
  {
    step: 3,
    title: 'スマホから試してみる',
    description:
      'このページをスマホのブラウザで開き、ホーム画面に追加すると、アプリのように使えます。',
    href: null,
  },
] as const;

// チュートリアルセクションを表示するかどうかの閾値 (テナント全体のチケット件数がこれ未満なら表示)
// 初期サンプルチケット 2 件を含む。小規模なインポート (数件程度) までは表示し続けるため 10 に設定
const TUTORIAL_TICKET_THRESHOLD = 10;

// /dashboard : 集計ダッシュボード (テナント mode と役割で表示が変わる)
export default async function DashboardPage() {
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
    return (
      <LiteDashboard
        isAgent={isAgent}
        userId={session.user.id}
        tenantId={tenantId}
        now={now}
        showTutorial={isAgent && totalTickets < TUTORIAL_TICKET_THRESHOLD}
      />
    );
  }

  // 以降は Pro モードの従来ダッシュボード (情シス向けのフル集計)
  // ダッシュボード用 3 指標 + 品質メトリクスを並列取得する
  // - byStatus: 7 状態それぞれの件数 (依頼者なら自身のチケットに限定)
  // - slaOverdue / workload: 当該テナント内全件対象 (表示は呼び出し側で role 制御)
  // - qualityMetrics: 平均初回応答時間・平均解決時間・再オープン率 (エージェント向け)
  const [stats, metrics] = await Promise.all([
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
    }),
    // 品質メトリクスはエージェントにのみ表示する重い全件集計クエリ。
    // 依頼者には不要なため取得も省略し、DB 負荷を抑える (§8 パフォーマンス)。
    isAgent ? repos.tickets.qualityMetrics({ tenantId }) : Promise.resolve(null),
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

      {/* 品質メトリクス (エージェントのみ。issue-backlog #25)
          metrics は isAgent=false のとき null なので null チェックを必ず通す */}
      {isAgent && metrics && (
        <section>
          <h2 className="mb-4 text-xs font-semibold tracking-wider text-slate-500 uppercase">
            対応品質
          </h2>
          {/* 3 指標がすべて null のときはデータ不足を明示する
              各指標はそれぞれ独立した分母を持つため、個別の null チェックで表示を制御する */}
          {metrics.avgFirstResponseMs == null &&
          metrics.avgResolutionMs == null &&
          metrics.reopenRate == null ? (
            <p className="text-sm text-slate-400">対応済みのチケットが蓄積されると指標が表示されます。</p>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {/* 平均初回応答時間 (分母: 初回応答済みチケット数) */}
              <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100">
                <p className="text-2xl font-bold text-slate-900">
                  {metrics.avgFirstResponseMs != null
                    ? formatDurationMs(metrics.avgFirstResponseMs)
                    : '—'}
                </p>
                <p className="mt-1 text-xs text-slate-500">平均初回応答時間</p>
              </div>
              {/* 平均解決時間 (分母: resolvedCount = 解決済みチケット数) */}
              <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100">
                <p className="text-2xl font-bold text-slate-900">
                  {metrics.avgResolutionMs != null
                    ? formatDurationMs(metrics.avgResolutionMs)
                    : '—'}
                </p>
                <p className="mt-1 text-xs text-slate-500">平均解決時間</p>
              </div>
              {/* 再オープン率 (分母: totalCount = 全チケット数。resolvedCount ではない) */}
              <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100">
                <p className="text-2xl font-bold text-slate-900">
                  {metrics.reopenRate != null
                    ? `${Math.round(metrics.reopenRate * 100)} %`
                    : '—'}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  再オープン率{' '}
                  {/* 分母ラベルは再オープン率が実際に計算されたときだけ表示する。
                      null (データ不足) の場合は「—」と並べて件数を出すと誤解を招くため非表示にする */}
                  {metrics.reopenRate != null && (
                    <span className="text-slate-400">(全 {metrics.totalCount} 件中)</span>
                  )}
                </p>
              </div>
            </div>
          )}
        </section>
      )}
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
}: {
  isAgent: boolean; // 担当者 (agent/admin) かどうか。'mine' の絞り込み方が依頼者と変わる
  userId: string; // ログインユーザー ID ('mine' で自分の担当/起票を絞る)
  tenantId: string; // テナントスコープ (件数取得に必須)
  now: Date; // 期限超過判定の基準時刻
  showTutorial: boolean; // Phase 3: チュートリアルセクションを表示するかどうか
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
            {GETTING_STARTED_STEPS.map(({ step, title, description, href }) => (
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
                <div
                  key={step}
                  className="rounded-2xl bg-slate-50 p-5 ring-1 ring-slate-200"
                >
                  {/* ステップ番号バッジ (リンクなし版) */}
                  <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-teal-100 text-xs font-bold text-teal-700">
                    {step}
                  </span>
                  {/* ステップのタイトル */}
                  <p className="mt-2 text-sm font-semibold text-slate-800">{title}</p>
                  {/* ステップの補足説明 */}
                  <p className="mt-1 text-xs text-slate-500">{description}</p>
                </div>
              )
            ))}
          </div>
          {/* チュートリアルガイドへの誘導 (ヘルプセンターの 30 分スタートガイドを案内する) */}
          <p className="mt-3 text-xs text-slate-400">
            詳しい手順は
            <Link href="/help/getting-started" className="mx-1 text-teal-700 underline hover:text-teal-800">
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
