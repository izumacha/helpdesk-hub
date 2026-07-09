// 404 (Not Found) を返すヘルパー
import { notFound } from 'next/navigation';
// セッション取得
import { auth } from '@/lib/auth';
// データ層の Composition Root (Prisma 直叩きを避ける)
import { repos } from '@/data';
// エージェント判定 (別名で衝突回避)
import { isAgent as checkIsAgent } from '@/lib/role';
// 表示用ラベル/カラークラス (ステータス/優先度/履歴) と履歴値変換ヘルパー
// getStatusLabel はテナント mode (lite | pro) に応じて Lite/Pro ラベルを切り替える
import {
  getStatusLabel,
  STATUS_COLORS,
  PRIORITY_LABELS,
  PRIORITY_COLORS,
  HISTORY_FIELD_LABELS,
  formatHistoryValue,
  getFaqEligibleStatuses,
  FAQ_TERM_LABELS,
} from '@/lib/constants';
// 現在ログイン中のテナントの動作モード (lite | pro) を取得するヘルパー
import { getCurrentTenantMode } from '@/lib/tenant';
// チケットの短縮参照番号 (受付番号) を組み立てる共有ヘルパー (メールの受領自動返信と同じ表記)
import { formatTicketRef } from '@/lib/ticket-ref';
// 日本時間 (Asia/Tokyo) で日付・日時を文字列化するユーティリティ
import { formatDateJP, formatDateTimeJP } from '@/lib/format-date';
// ステータス変更プルダウン
import { StatusSelect } from '@/features/tickets/components/StatusSelect';
// 優先度変更プルダウン
import { PrioritySelect } from '@/features/tickets/components/PrioritySelect';
// 担当者変更プルダウン
import { AssigneeSelect } from '@/features/tickets/components/AssigneeSelect';
// コメント投稿フォーム
import { CommentForm } from '@/features/tickets/components/CommentForm';
// 添付ファイル (画像) のサムネ一覧コンポーネント
import { AttachmentList } from '@/features/tickets/components/AttachmentList';
// エスカレーション操作フォーム
import { EscalationForm } from '@/features/tickets/components/EscalationForm';
// SLA 状態判定 + ラベル/カラー定義。FIRST_RESPONSE_HOURS_BY_PRIORITY は初回応答 SLA の
// 警告閾値を窓の長さに応じて計算するために使う (getSlaState の既定 24 時間閾値をそのまま
// 使うと、4〜24 時間しかない初回応答期限では起票直後から常に warning になってしまうため)
import { getSlaState, SLA_LABELS, SLA_COLORS, FIRST_RESPONSE_HOURS_BY_PRIORITY } from '@/lib/sla';
// 現ステータスから許可される遷移先一覧を取得
import { getAllowedTransitions } from '@/domain/ticket-status';
// FAQ 候補登録フォーム
import { FaqCandidateForm } from '@/features/faq/components/FaqCandidateForm';

// /tickets/[id] ページの props (動的セグメント id を受け取る)
interface Props {
  params: Promise<{ id: string }>;
}

// /tickets/[id] : チケット詳細ページ
export default async function TicketDetailPage({ params }: Props) {
  // 動的セグメントを取り出す
  const { id } = await params;
  // セッション取得
  const session = await auth();
  // 未ログイン or tenantId 不在なら描画しない。tenantId が undefined のまま下の
  // findByIdWithDetail に渡すと、Prisma が where から tenantId 条件を脱落させ
  // (undefined 条件を無視する仕様)、全テナントのチケットに一致してしまう。
  // 他の認証済みページ (tickets/page.tsx, notifications/page.tsx 等) と同じく
  // ここでも tenantId を明示チェックしてクロステナント漏洩を多層防御で防ぐ (CLAUDE.md §3/§9)。
  if (!session?.user?.id || !session.user.tenantId) return null;

  // ロール判定
  const isAgent = checkIsAgent(session.user.role);

  // セッションから tenantId を取り出して以降の port 呼び出しに伝搬する
  const tenantId = session.user.tenantId;
  // チケット本体・担当者候補・テナント mode を並列取得 (全て tenantId スコープ)
  const [ticket, agents, mode] = await Promise.all([
    // 詳細用: 起票者/担当者/カテゴリ/コメント/履歴/FAQ 候補をまとめて取得
    repos.tickets.findByIdWithDetail(id, tenantId),
    // エージェント時のみ担当者候補一覧を取得 (テナント内のみ)
    isAgent ? repos.users.listAgents(tenantId) : Promise.resolve([]),
    // テナントの動作モード (lite | pro) を取得し、ステータス表記を Lite/Pro で切り替える
    getCurrentTenantMode(tenantId),
  ]);

  // チケットが存在しなければ 404
  if (!ticket) notFound();

  // RBAC: 依頼者は自分が作成したチケットのみ閲覧可
  if (!isAgent && ticket.creatorId !== session.user.id) notFound();

  // SLA 状態 (none/ok/warning/overdue) を計算
  const slaState = getSlaState(ticket.resolutionDueAt, ticket.resolvedAt);
  // 初回応答 SLA 状態 (Pro モードのみ表示。Lite は「期限日」1 項目に統合する方針のため対象外)。
  // 警告閾値は「窓 (優先度ごとの許容時間) の 25%」を渡す。解決期限向けの既定 24 時間閾値を
  // そのまま使うと、High=4h/Medium=8h/Low=24h しかない初回応答期限では起票直後から
  // ずっと warning になってしまう (回帰防止: /code-review ultra 指摘)
  const firstResponseSlaState =
    mode === 'pro'
      ? getSlaState(
          ticket.firstResponseDueAt,
          ticket.firstRespondedAt,
          FIRST_RESPONSE_HOURS_BY_PRIORITY[ticket.priority] * 0.25 * 60 * 60 * 1000,
        )
      : 'none';
  // エスカレーション可能か (エージェント && 現状から Escalated への遷移許可あり)
  // Pro モードの遷移表を参照する (Lite モードでは Escalated 自体が UI 上は存在しない)
  const canEscalate =
    isAgent && mode === 'pro' && getAllowedTransitions(ticket.status, 'pro').includes('Escalated');
  // FAQ 候補化可能か (エージェント && mode-aware な完了状態 && 既存 FAQ 候補なし)
  // (§1.1 フォローアップ: Resolved 固定だと Lite テナントのチケットは常に false になっていた)
  const canAddFaq =
    isAgent && getFaqEligibleStatuses(mode).includes(ticket.status) && !ticket.faqCandidate;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* タイトル領域 (短縮 ID + 件名) */}
      <div>
        <p className="text-sm text-gray-500">{formatTicketRef(ticket.id)}</p>
        <h1 className="mt-1 text-2xl font-bold text-gray-900">{ticket.title}</h1>
      </div>

      {/* 2 カラム (本文/コメント/履歴 と サイドバー) */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* メインコンテンツ */}
        <div className="space-y-6 lg:col-span-2">
          {/* 問い合わせ本文 */}
          <section className="rounded-lg bg-white p-5 shadow-sm">
            <h2 className="mb-3 text-sm font-semibold text-gray-500">問い合わせ内容</h2>
            <p className="text-sm whitespace-pre-wrap text-gray-800">{ticket.body}</p>
            {/* チケット本体に直接添付された画像のサムネ一覧 (0 件なら描画しない) */}
            {ticket.attachments.length > 0 && (
              <div className="mt-4">
                <AttachmentList attachments={ticket.attachments} heading="添付ファイル" />
              </div>
            )}
          </section>

          {/* コメントセクション */}
          <section className="rounded-lg bg-white p-5 shadow-sm">
            <h2 className="mb-4 text-sm font-semibold text-gray-500">
              コメント（{ticket.comments.length}件）
            </h2>

            {ticket.comments.length === 0 ? (
              // コメント 0 件のメッセージ
              <p className="mb-4 text-sm text-gray-400">まだコメントはありません</p>
            ) : (
              // コメントを古い順に列挙
              <ul className="mb-4 space-y-4">
                {ticket.comments.map((c) => (
                  <li key={c.id} className="border-l-2 border-gray-200 pl-4">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-700">{c.author.name}</span>
                      <span className="text-xs text-gray-400">
                        {/* コメント投稿日時を日本時間で表示する */}
                        {formatDateTimeJP(c.createdAt)}
                      </span>
                    </div>
                    <p className="text-sm whitespace-pre-wrap text-gray-700">{c.body}</p>
                    {/* コメントに紐づく添付があれば直下にサムネを描画する */}
                    {c.attachments.length > 0 && (
                      <div className="mt-2">
                        <AttachmentList attachments={c.attachments} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {/* コメント投稿フォーム */}
            <CommentForm ticketId={ticket.id} />
          </section>

          {/* 変更履歴セクション */}
          <section className="rounded-lg bg-white p-5 shadow-sm">
            <h2 className="mb-4 text-sm font-semibold text-gray-500">変更履歴</h2>
            {ticket.histories.length === 0 ? (
              <p className="text-sm text-gray-400">変更履歴はありません</p>
            ) : (
              <ul className="space-y-2">
                {ticket.histories.map((h) => {
                  // 旧値・新値を field 種別に応じて日本語ラベル化しておく (JSX 内の改行で余計な空白が入らないよう変数化)
                  // mode を渡すと status/escalation 行が Lite/Pro 表記に切り替わる
                  const oldLabel = formatHistoryValue(h.field, h.oldValue, mode);
                  // 新値ラベル
                  const newLabel = formatHistoryValue(h.field, h.newValue, mode);
                  return (
                    <li key={h.id} className="flex items-start gap-2 text-sm text-gray-600">
                      <span className="mt-0.5 text-xs text-gray-400">
                        {/* 履歴記録日時を日本時間で表示する */}
                        {formatDateTimeJP(h.createdAt)}
                      </span>
                      <span>
                        <span className="font-medium">{h.changedBy.name}</span> が{' '}
                        <span className="font-medium">
                          {HISTORY_FIELD_LABELS[h.field] ?? h.field}
                        </span>{' '}
                        {/* 鍵括弧の直後に改行を入れると JSX が半角空白を挿入するため一行で書く */}
                        を「{oldLabel}」→「{newLabel}」に変更
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        {/* サイドバー (詳細情報 + 操作群) */}
        <aside className="space-y-4">
          <div className="rounded-lg bg-white p-5 shadow-sm">
            <h2 className="mb-4 text-sm font-semibold text-gray-500">詳細</h2>

            <dl className="space-y-3 text-sm">
              {/* ステータス (エージェントは変更プルダウン付き、ラベルはテナント mode で切替) */}
              <div>
                <dt className="font-medium text-gray-500">ステータス</dt>
                <dd className="mt-1">
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[ticket.status] ?? ''}`}
                  >
                    {getStatusLabel(ticket.status, mode)}
                  </span>
                  {isAgent && (
                    <div className="mt-1">
                      <StatusSelect ticketId={ticket.id} current={ticket.status} mode={mode} />
                    </div>
                  )}
                </dd>
              </div>

              {/* 優先度 (エージェントは変更プルダウン付き) */}
              <div>
                <dt className="font-medium text-gray-500">優先度</dt>
                <dd className="mt-1">
                  <span className={`text-sm ${PRIORITY_COLORS[ticket.priority] ?? ''}`}>
                    {PRIORITY_LABELS[ticket.priority] ?? ticket.priority}
                  </span>
                  {isAgent && (
                    <div className="mt-1">
                      <PrioritySelect ticketId={ticket.id} current={ticket.priority} />
                    </div>
                  )}
                </dd>
              </div>

              {/* 担当者 (エージェントは変更可、それ以外は表示のみ) */}
              <div>
                <dt className="font-medium text-gray-500">担当者</dt>
                <dd className="mt-1">
                  {isAgent ? (
                    <AssigneeSelect
                      ticketId={ticket.id}
                      currentAssigneeId={ticket.assigneeId}
                      agents={agents}
                    />
                  ) : (
                    <span className="text-gray-700">{ticket.assignee?.name ?? '未割当'}</span>
                  )}
                </dd>
              </div>

              {/* カテゴリ */}
              <div>
                <dt className="font-medium text-gray-500">カテゴリ</dt>
                <dd className="mt-1 text-gray-700">{ticket.category?.name ?? '―'}</dd>
              </div>

              {/* 拠点 (Phase 4 多拠点。未指定なら "―") */}
              <div>
                <dt className="font-medium text-gray-500">拠点</dt>
                <dd className="mt-1 text-gray-700">{ticket.location?.name ?? '―'}</dd>
              </div>

              {/* 登録者 (チケット作成者) */}
              <div>
                <dt className="font-medium text-gray-500">登録者</dt>
                <dd className="mt-1 text-gray-700">{ticket.creator.name}</dd>
              </div>

              {/* 作成日 */}
              <div>
                <dt className="font-medium text-gray-500">作成日</dt>
                <dd className="mt-1 text-gray-700">
                  {/* チケット作成日を日本時間 (年月日) で表示する */}
                  {formatDateJP(ticket.createdAt)}
                </dd>
              </div>

              {/* SLA: 初回応答期限 (Pro モード限定。Lite は「期限日」1 項目に統合する方針のため非表示) */}
              {mode === 'pro' && ticket.firstResponseDueAt && (
                <div>
                  <dt className="font-medium text-gray-500">初回応答期限</dt>
                  <dd className="mt-1 flex items-center gap-2">
                    <span className="text-gray-700">
                      {/* 初回応答期限を日本時間 (年月日) で表示する */}
                      {formatDateJP(ticket.firstResponseDueAt)}
                    </span>
                    {/* 応答済みなら日時を、未応答なら警告/超過バッジを表示する */}
                    {ticket.firstRespondedAt ? (
                      <span className="text-xs text-gray-500">
                        （{formatDateTimeJP(ticket.firstRespondedAt)} 応答済み）
                      </span>
                    ) : (
                      firstResponseSlaState !== 'none' &&
                      firstResponseSlaState !== 'ok' && (
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${SLA_COLORS[firstResponseSlaState]}`}
                        >
                          {SLA_LABELS[firstResponseSlaState]}
                        </span>
                      )
                    )}
                  </dd>
                </div>
              )}

              {/* SLA: 解決期限がある場合のみ表示 */}
              {ticket.resolutionDueAt && (
                <div>
                  <dt className="font-medium text-gray-500">解決期限</dt>
                  <dd className="mt-1 flex items-center gap-2">
                    <span className="text-gray-700">
                      {/* SLA 解決期限を日本時間 (年月日) で表示する */}
                      {formatDateJP(ticket.resolutionDueAt)}
                    </span>
                    {/* 警告/超過などの状態バッジ (none/ok 以外で表示) */}
                    {slaState !== 'none' && slaState !== 'ok' && (
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${SLA_COLORS[slaState]}`}
                      >
                        {SLA_LABELS[slaState]}
                      </span>
                    )}
                  </dd>
                </div>
              )}

              {/* エスカレーション情報 (発生済みの場合のみ表示) */}
              {ticket.escalatedAt && (
                <div>
                  <dt className="font-medium text-gray-500">エスカレーション日時</dt>
                  <dd className="mt-1 text-gray-700">
                    {/* エスカレーション発生日時を日本時間で表示する */}
                    {formatDateTimeJP(ticket.escalatedAt)}
                  </dd>
                  {ticket.escalationReason && (
                    <dd className="mt-1 text-xs text-gray-500">{ticket.escalationReason}</dd>
                  )}
                </div>
              )}

              {/* エスカレーション操作 (権限+遷移可のみ表示) */}
              {canEscalate && (
                <div>
                  <dt className="font-medium text-gray-500">エスカレーション</dt>
                  <dd className="mt-1">
                    <EscalationForm ticketId={ticket.id} />
                  </dd>
                </div>
              )}

              {/* FAQ 候補登録フォーム (条件を満たすときのみ表示。呼称は mode-aware) */}
              {canAddFaq && (
                <div>
                  <dt className="font-medium text-gray-500">{FAQ_TERM_LABELS[mode]}</dt>
                  <dd className="mt-1">
                    <FaqCandidateForm ticketId={ticket.id} ticketTitle={ticket.title} mode={mode} />
                  </dd>
                </div>
              )}
              {/* 既に FAQ 候補化済みの場合は登録済み表示 */}
              {ticket.faqCandidate && (
                <div>
                  <dt className="font-medium text-gray-500">{FAQ_TERM_LABELS[mode]}</dt>
                  <dd className="mt-1 text-xs text-green-600">登録済み</dd>
                </div>
              )}
            </dl>
          </div>
        </aside>
      </div>
    </div>
  );
}
