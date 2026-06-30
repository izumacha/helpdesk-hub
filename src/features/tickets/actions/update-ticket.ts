'use server';

// ページキャッシュを無効化する Next.js の関数
import { revalidatePath } from 'next/cache';
// 現在のセッション (ログイン中ユーザー) を取得
import { auth } from '@/lib/auth';
// リポジトリ束 (repos) と 1 トランザクション実行用 (uow)
import { repos, uow } from '@/data';
// 未読件数を SSE で即時配信するヘルパー (単数/複数宛)
import { broadcastUnreadCount, broadcastUnreadCountToMany } from '@/features/notifications/notify';
// エージェント権限判定 (agent または admin のとき true)
import { isAgent } from '@/lib/role';
// ステータス遷移が許可されているか判定するドメイン関数 (mode 引数で Lite/Pro 切替)
// および Lite モード専用の遷移表ガード / Lite ステータス型ガード
import {
  getAllowedLiteTransitions,
  isLiteStatus,
  isValidTransition,
  type LiteStatus,
} from '@/domain/ticket-status';
// セッションの tenantId からテナント mode (lite | pro) を取得するヘルパー
import { getCurrentTenantMode } from '@/lib/tenant';
// ステータス・優先度などの一元管理ラベル取得関数
import { getStatusLabel } from '@/lib/constants';
// 型のみインポート (優先度/ステータス)
import type { Priority, TicketStatus } from '@/domain/types';
// レート制限 (連打防止) の共通ヘルパー
import { enforceRateLimit } from '@/lib/rate-limit';
// Zod スキーマ (エスカレーション理由の検証用)
import { escalationReasonSchema } from '@/lib/validations/ticket';
// next-auth のセッション型
import type { Session } from 'next-auth';
// ステータス変更・担当者割当・エスカレーションのメール本文を生成する純粋ヘルパー (Phase 2)
import {
  renderTicketStatusChangedEmail,
  renderAssignedEmail,
  renderEscalatedEmail,
  buildTicketUrl,
} from '@/lib/ticket-email';
// EmailSender 実装を取得するファクトリ (環境変数で console / smtp を切り替え)
import { getEmailSender } from '@/lib/email';
// メールに埋め込むリンクのベース URL を解決するヘルパー
import { resolveAppBaseUrl } from '@/lib/app-url';
// Phase 4: Slack/Teams 外部通知ヘルパー (失敗してもチケット操作を止めない)
import { sendOutboundNotification } from '@/lib/outbound-notify';

// セッションがログイン済みであることを保証するアサーション関数
function assertAuthenticatedUser(session: Session | null): asserts session is Session {
  // ユーザー ID が無ければ未ログインとみなしてエラー
  if (!session?.user?.id) throw new Error('Unauthorized');
  // tenantId 不在は middleware で弾く想定だが、Server Action でも防御的にチェック
  if (!session.user.tenantId) throw new Error('Unauthorized');
}

// セッションがエージェント/管理者権限を持つことを保証するアサーション関数
function assertAgentRole(session: Session | null): asserts session is Session {
  // まずログイン済みかをチェック
  assertAuthenticatedUser(session);
  // エージェント/管理者でなければ拒否
  if (!isAgent(session.user.role)) {
    throw new Error('この操作はエージェントまたは管理者のみ実行できます');
  }
}

// チケットのステータスを変更するサーバーアクション
export async function updateTicketStatus(ticketId: string, newStatus: TicketStatus) {
  // セッション取得
  const session = await auth();
  // エージェント以上の権限を要求
  assertAgentRole(session);
  // セッションから tenantId を取り出して以降の where 句注入に使う
  const tenantId = session.user.tenantId;
  // テナントの動作モード (lite | pro) を取得し、遷移表の切替に使う
  // UI (StatusSelect) が表示する選択肢と整合させ、Lite で許される InProgress→Open 等を弾かないようにする
  const mode = await getCurrentTenantMode(tenantId);
  // 10 秒あたり 10 回までに制限 (チケット単位)
  enforceRateLimit(`ticket-status:${session.user.id}:${ticketId}`, { limit: 10, windowMs: 10_000 });

  // コミット後の broadcastUnreadCount に渡す「通知を実際に書き込んだ起票者 ID」を保持する
  // (ticket は uow.run 内で取得するため、クロージャ変数として外側に宣言しておく必要がある)
  // 自己更新 (起票者=操作者) では通知を作らないため null のままにし、無駄な SSE 配信を避ける
  let notifiedCreatorId: string | null = null;
  // メール送信に必要なチケット情報 (起票者 ID・件名) を uow.run 外で参照するために宣言
  // null のままならメールは送らない (自己更新 or チケット未取得)
  let ticketSnapshot: { creatorId: string; title: string } | null = null;
  // ステータス変更前の値 (メール本文でラベルを出すために外側で保持する)
  let oldStatus: TicketStatus | null = null;

  // 1 トランザクションでチケット更新と履歴記録を実行
  await uow.run(async (r) => {
    // 対象チケットを tenantId スコープで取得
    const ticket = await r.tickets.findById(ticketId, tenantId);
    // 見つからない or 他テナントの ID ならエラー
    if (!ticket) throw new Error('チケットが見つかりません');
    // 変更前後が同じなら何もしない (冪等)
    if (ticket.status === newStatus) return;
    // 変更前のステータスをトランザクション外のメール送信に伝えるために外側変数に保存する
    oldStatus = ticket.status;
    // 件名と起票者 ID もメール送信用に外側変数に保存する
    ticketSnapshot = { creatorId: ticket.creatorId, title: ticket.title };
    // Lite テナントでは newStatus を Lite 3 値 (Open / InProgress / Closed) に強制する
    // 旧データ (Resolved / Escalated / WaitingForUser / New) からの off-ramp は許すが、
    // Lite テナント上で「新規にそれら非 Lite ステータスへ落とす」操作は仕様違反 (Pivot plan §3.1 / §5.2)
    if (mode === 'lite' && !isLiteStatus(newStatus)) {
      throw new Error(`Lite モードでは「${newStatus}」へは変更できません`);
    }
    // 遷移許可判定:
    // - Lite モードかつ from も Lite 3 値: 専用遷移表 (getAllowedLiteTransitions) を直接ガードに使う
    //   (直前の isLiteStatus(newStatus) 判定で newStatus は LiteStatus が確定するが、
    //    TS の制御フローを跨いだ narrow が効かないので as LiteStatus でローカルキャスト)
    // - それ以外 (Pro モード / Lite × 非 Lite 始点の off-ramp): 従来どおり mode-aware な isValidTransition
    const guardPassed =
      mode === 'lite' && isLiteStatus(ticket.status)
        ? getAllowedLiteTransitions(ticket.status).includes(newStatus as LiteStatus)
        : isValidTransition(ticket.status, newStatus, mode);
    if (!guardPassed) {
      throw new Error(
        `ステータスを「${ticket.status}」から「${newStatus}」に変更することはできません`,
      );
    }

    // 「完了」とみなすステータス集合を mode に応じて決定する
    // - Pro: ['Resolved'] (従来どおり「解決済み」が完了扱い)
    // - Lite: ['Closed', 'Resolved'] — Lite UI の「完了」は Closed に対応するが、Lite 遷移表が
    //   Lite 非対応ステータス (例: 旧 Pro データの Resolved) から Pro 表へフォールバックするため、
    //   Lite テナントでも Resolved が残っている可能性がある。両方を完了扱いにしておくことで、
    //   ・新規完了 (Closed) で resolvedAt をセット
    //   ・旧 Resolved データの再オープン (Resolved → Open) で resolvedAt をクリア
    //   の両方を一貫して扱える。
    // これがズレると Lite 完了済みチケットでも resolvedAt=null のまま (SLA 期限切れ表示)、
    // または再オープン後も resolvedAt が残る (SLA 解決済み表示) などの不整合が起きる。
    const completionStatuses: TicketStatus[] =
      mode === 'lite' ? ['Closed', 'Resolved'] : ['Resolved'];
    // 完了集合に入る遷移なら現在時刻に、完了集合から離れる場合はクリア、それ以外は据え置き
    const resolvedAt = completionStatuses.includes(newStatus)
      ? new Date()
      : completionStatuses.includes(ticket.status)
        ? null
        : ticket.resolvedAt;

    // ステータスと解決日時を更新 (tenantId スコープで where に注入)
    await r.tickets.updateStatus(ticketId, newStatus, resolvedAt, tenantId);
    // 変更履歴を残す (誰が/どの項目を/旧値→新値)
    await r.history.record({
      ticketId,
      changedById: session.user.id,
      field: 'status',
      oldValue: ticket.status,
      newValue: newStatus,
    });
    // 自分以外の起票者にのみ通知を送る (エージェント本人が起票したチケットを更新する場合は自己通知しない)
    if (ticket.creatorId !== session.user.id) {
      // 起票者にステータス変更通知を DB に書き込む
      await r.notifications.create({
        userId: ticket.creatorId, // 通知の受信者は起票者
        type: 'statusChanged', // 通知の種別: ステータス変更
        // getStatusLabel で「InProgress」→「対応中」のようにテナントモードに合わせた日本語表示に変換
        message: `チケット「${ticket.title}」のステータスが「${getStatusLabel(newStatus, mode)}」に変更されました`, // 表示文言
        ticketId, // 関連チケット ID
        tenantId: ticket.tenantId, // テナントスコープ (クロステナント漏洩防止)
      });
      // 通知を書き込んだ起票者 ID を外側変数に渡す (コミット後の SSE 配信に使う)
      notifiedCreatorId = ticket.creatorId;
    }
  });

  // 通知を実際に書き込んだ場合のみ、起票者の未読件数を SSE でリアルタイム配信する
  // (トランザクションコミット後に呼ぶ。自己更新時は notifiedCreatorId が null なので配信しない)
  if (notifiedCreatorId) await broadcastUnreadCount(notifiedCreatorId, tenantId);

  // Phase 2: ステータス変更を依頼者へメールで通知する (ベストエフォート)
  // ticketSnapshot / oldStatus は uow.run クロージャ内で代入される let 変数。
  // TSC の CFA は async クロージャを跨いだ let 変数を never に絞り込んでしまうため、
  // 宣言型で明示アサーションして const に取り出してから null チェックを行う。
  const snapForMail = ticketSnapshot as { creatorId: string; title: string } | null;
  const oldStatusForMail = oldStatus as TicketStatus | null;
  // スナップショットと変更前ステータスが揃い、かつ自分以外の起票者がいる場合のみ送信する
  if (
    snapForMail !== null &&
    oldStatusForMail !== null &&
    snapForMail.creatorId !== session.user.id
  ) {
    // メール送信を別関数に切り出して try/catch で囲み、失敗してもチケット更新は巻き戻さない
    await sendStatusChangedEmailToRequester({
      ticketId,
      ticketTitle: snapForMail.title,
      creatorId: snapForMail.creatorId,
      oldStatus: oldStatusForMail,
      newStatus,
      mode,
    });
  }

  // Phase 4: Slack/Teams 外部通知 (ステータス変更をチャネルに投稿する)
  // Slack 通知はチームの共有チャネル宛なので、自己更新でも全員に通知する (メール個人通知とは異なる意図)。
  // スナップショットが取れた場合のみ送信 (変更なし / チケット未取得のケースは skip)。
  // 外部通知の失敗は DB 更新済みのチケットに影響しないよう try/catch で包み、エラーをログに留める。
  const snapForSlack = ticketSnapshot as { creatorId: string; title: string } | null;
  if (snapForSlack !== null) {
    try {
      // ベースURLを取得してチケットリンクを組み立てる (NEXTAUTH_URL 未設定時に例外が出る可能性があるため内側に置く)
      const baseUrl = resolveAppBaseUrl();
      // 外部チャネル (Slack/Teams/Chatwork) に通知を送る
      await sendOutboundNotification(tenantId, {
        subject: `ステータスが変更されました: ${snapForSlack.title}`,
        body: `「${snapForSlack.title}」のステータスが「${getStatusLabel(newStatus, mode)}」に変更されました。`,
        ticketUrl: `${baseUrl}/tickets/${ticketId}`,
      });
    } catch (err) {
      // 外部通知の失敗はログに記録するが、チケット更新自体は成功扱いにする
      // (ネットワーク障害・Webhook 設定ミスでチケット操作が失敗に見えるのを防ぐ)
      console.error('[update-ticket] 外部通知の送信に失敗しました (チケット更新は完了):', err);
    }
  }

  // チケット詳細ページのキャッシュを無効化して再描画
  revalidatePath(`/tickets/${ticketId}`);
}

// チケットの優先度を変更するサーバーアクション
export async function updateTicketPriority(ticketId: string, newPriority: Priority) {
  // セッション取得
  const session = await auth();
  // エージェント以上のみ実行可
  assertAgentRole(session);
  // テナントスコープ用に tenantId を取り出す
  const tenantId = session.user.tenantId;
  // 10 秒あたり 10 回までに制限
  enforceRateLimit(`ticket-priority:${session.user.id}:${ticketId}`, {
    limit: 10,
    windowMs: 10_000,
  });

  // 1 トランザクションで更新と履歴記録
  await uow.run(async (r) => {
    // チケットを tenantId スコープで取得
    const ticket = await r.tickets.findById(ticketId, tenantId);
    // 無ければエラー
    if (!ticket) throw new Error('チケットが見つかりません');
    // 変更無しならスキップ
    if (ticket.priority === newPriority) return;

    // 優先度を更新 (tenantId スコープで where に注入)
    await r.tickets.updatePriority(ticketId, newPriority, tenantId);
    // 履歴を記録
    await r.history.record({
      ticketId,
      changedById: session.user.id,
      field: 'priority',
      oldValue: ticket.priority,
      newValue: newPriority,
    });
  });

  // 詳細ページのキャッシュ無効化
  revalidatePath(`/tickets/${ticketId}`);
}

// チケットの担当者を割当/解除するサーバーアクション
export async function updateTicketAssignee(ticketId: string, newAssigneeId: string | null) {
  // セッション取得
  const session = await auth();
  // エージェント以上のみ実行可
  assertAgentRole(session);
  // テナントスコープ用に tenantId を取り出す
  const tenantId = session.user.tenantId;
  // 10 秒あたり 10 回までに制限
  enforceRateLimit(`ticket-assignee:${session.user.id}:${ticketId}`, {
    limit: 10,
    windowMs: 10_000,
  });

  // チケット (既存担当者含む) と新担当者候補を並列で取得
  // チケットは tenantId スコープで引き、ユーザーはテナント横断 (後段でテナント一致を検証)
  const [ticket, newUser] = await Promise.all([
    repos.tickets.findByIdWithRefs(ticketId, tenantId),
    newAssigneeId ? repos.users.findById(newAssigneeId) : Promise.resolve(null),
  ]);

  // チケットが無ければエラー
  if (!ticket) throw new Error('チケットが見つかりません');
  // 担当者を付ける場合は相手の存在 / ロール / テナント一致を確認
  if (newAssigneeId) {
    // 拒否理由を特定 (内部診断用、レスポンス本文には漏らさない)
    const reason = !newUser
      ? 'not-found'
      : !isAgent(newUser.role)
        ? 'not-agent'
        : newUser.tenantId !== tenantId
          ? 'cross-tenant' // 別テナントのユーザーを割り当てようとした
          : null;
    if (reason) {
      // 診断用ログ (不正割当の調査向け)
      console.warn('[updateTicketAssignee] rejected', { ticketId, newAssigneeId, reason });
      throw new Error('指定された担当者を設定できません');
    }
  }

  // 履歴に残す旧/新の担当者名 (未割当は null)
  const oldName = ticket.assignee?.name ?? null;
  const newName = newUser?.name ?? null;

  // 担当者更新・履歴記録・通知作成を 1 トランザクションで実行
  await uow.run(async (r) => {
    // 担当者を差し替え (解除は null。tenantId スコープで where に注入)
    await r.tickets.updateAssignee(ticketId, newAssigneeId, tenantId);
    // 変更履歴を残す
    await r.history.record({
      ticketId,
      changedById: session.user.id,
      field: 'assignee',
      oldValue: oldName,
      newValue: newName,
    });
    // 新担当者が居る場合のみ通知を生成
    if (newAssigneeId) {
      await r.notifications.create({
        userId: newAssigneeId,
        type: 'assigned',
        message: `チケット「${ticket.title}」の担当者に割り当てられました`,
        ticketId,
        // 通知も同じテナントスコープで保存 (チケットと同テナント)
        tenantId: ticket.tenantId,
      });
    }
  });

  // 新担当者に未読件数を SSE で即時配信 (テナントを伝搬)
  if (newAssigneeId) await broadcastUnreadCount(newAssigneeId, tenantId);

  // Phase 2: 担当者割当を新担当者へメールで通知する (ベストエフォート)
  // 担当者解除 (null) か自己割当なら送らない
  if (newAssigneeId && newAssigneeId !== session.user.id && newUser?.email) {
    // メール送信の失敗でチケット更新が巻き戻るのを防ぐため try/catch に包む
    try {
      // ベース URL を解決する (production で NEXTAUTH_URL 未設定なら throw される)
      const baseUrl = resolveAppBaseUrl();
      // チケット詳細ページへの導線 URL を組み立てる
      const ticketUrl = buildTicketUrl(baseUrl, ticketId);
      // 担当者割当メールの件名 / テキスト / HTML を純粋ヘルパーで生成する
      const { subject, text, html } = renderAssignedEmail({
        ticketTitle: ticket.title,
        ticketUrl,
      });
      // 設定された EmailSender (console / smtp) 経由でメール送信
      await getEmailSender().send({ to: newUser.email, subject, text, html });
    } catch (err) {
      // 送信失敗はサーバログに残すだけ (アプリ内通知は既に成立している)
      console.error('[updateTicketAssignee] 担当者宛メール送信に失敗しました', err);
    }
  }

  // 詳細ページのキャッシュを無効化
  revalidatePath(`/tickets/${ticketId}`);
}

// チケットをエスカレーション (上位対応へ引き上げ) するサーバーアクション
export async function escalateTicket(ticketId: string, reason: string) {
  // セッション取得
  const session = await auth();
  // エージェント以上のみ実行可
  assertAgentRole(session);
  // テナントスコープ用に tenantId を取り出す
  const tenantId = session.user.tenantId;
  // エスカレーションは全エージェントに通知が飛ぶため、通常操作より厳しく制限
  // (60 秒あたり 5 回まで)
  enforceRateLimit(`ticket-escalate:${session.user.id}`, { limit: 5, windowMs: 60_000 });

  // 理由文を Zod で検証 (長さや必須チェック)
  const parsedReason = escalationReasonSchema.safeParse(reason);
  // 検証失敗ならエラーを日本語で投げる
  if (!parsedReason.success) {
    throw new Error(parsedReason.error.issues[0]?.message ?? 'エスカレーション理由が不正です');
  }
  // 検証済み (trim 等済み) の理由を取り出す
  const trimmedReason = parsedReason.data;

  // 先にチケット本体とテナント mode を並列取得 (Lite ガード判定に必要な最小集合)
  // 通知用 agentIds は Pro 経路確定後に取得することで Lite 早期 throw 時の無駄な DB アクセスを回避する
  const [ticket, mode] = await Promise.all([
    repos.tickets.findById(ticketId, tenantId),
    getCurrentTenantMode(tenantId),
  ]);

  // チケットが無ければエラー
  if (!ticket) throw new Error('チケットが見つかりません');
  // Lite モードではエスカレーション機能そのものを提供しない (Pivot plan §3.1 / §5.2)
  // - UI 側 (src/app/(app)/tickets/[id]/page.tsx) でも mode==='pro' でしかボタンを出さない
  // - 二重防御として Server Action にも明示ガードを置き、将来の遷移表変更で偶発的に
  //   Lite テナントでエスカレーションが通る回帰を防ぐ
  if (mode === 'lite') {
    throw new Error('Lite モードではエスカレーションは利用できません');
  }
  // Escalated への遷移が許可されているか確認 (Pro 経路の現在ステータス判定として残す)
  if (!isValidTransition(ticket.status, 'Escalated', mode)) {
    throw new Error(`現在のステータス「${ticket.status}」からエスカレーションできません`);
  }

  // ここから先は Pro 経路確定。通知対象の全エージェント (id + email) をテナントスコープで取得。
  // email も併せて取るのは、後段のエスカレーションメール一斉送信で N+1 (id ごとの findById) を避けるため。
  const agents = await repos.users.listAgentEmails(tenantId);
  const agentIds = agents.map((a) => a.id);

  // エスカレーション発生時刻
  const now = new Date();
  // メッセージ組み立てに使うタイトルを取り出す
  const { title } = ticket;

  // マーク・履歴・エージェント一斉通知を 1 トランザクションで実行
  await uow.run(async (r) => {
    // チケットに Escalated フラグと理由/日時を書き込む (tenantId スコープ)
    await r.tickets.markEscalated(ticketId, { reason: trimmedReason, at: now }, tenantId);
    // 変更履歴を残す
    await r.history.record({
      ticketId,
      changedById: session.user.id,
      field: 'escalation',
      oldValue: ticket.status,
      newValue: 'Escalated',
    });
    // 全エージェントに「エスカレーションされました」通知を作成
    await Promise.all(
      agentIds.map((id) =>
        r.notifications.create({
          userId: id,
          type: 'escalated',
          message: `チケット「${title}」がエスカレーションされました`,
          ticketId,
          // チケットと同じテナントスコープで通知を保存
          tenantId: ticket.tenantId,
        }),
      ),
    );
  });

  // 全エージェントへ未読件数を一斉配信 (テナントを伝搬)
  await broadcastUnreadCountToMany(agentIds, tenantId);

  // Phase 2「メール通知テンプレートの整備」(docs/smb-dx-pivot-plan.md §4 Phase 2):
  // エスカレーションを操作者以外の全エージェントへメールで知らせる (ベストエフォート)。
  // エスカレーションは全エージェントへの一斉通知という性質上、1 通の失敗が他へ波及しないよう
  // allSettled で並行送信し、失敗は件数だけログに残す。
  try {
    // ベース URL を解決してチケットリンクを組み立てる (NEXTAUTH_URL 未設定時は例外 → 下の catch で握る)
    const baseUrl = resolveAppBaseUrl();
    const ticketUrl = buildTicketUrl(baseUrl, ticketId);
    // 件名 / 本文 (Text / HTML) を純粋ヘルパーで構築
    const { subject, text, html } = renderEscalatedEmail({
      ticketTitle: title,
      ticketUrl,
      reason: trimmedReason,
    });
    // 操作者本人 (エスカレーションを実行したエージェント) は自分の操作を知っているため除く
    const recipients = agents.filter((a) => a.id !== session.user.id);
    const results = await Promise.allSettled(
      recipients.map((a) => getEmailSender().send({ to: a.email, subject, text, html })),
    );
    const failedCount = results.filter((r) => r.status === 'rejected').length;
    if (failedCount > 0) {
      console.warn(`[escalateTicket] ${failedCount} 件のエージェント宛メール送信に失敗しました`);
    }
  } catch (err) {
    // URL 解決失敗等、本文組み立て自体に失敗した場合もログのみに留める (アプリ内通知は既に成立している)
    console.error('[escalateTicket] エージェント宛メール送信に失敗しました', err);
  }

  // 詳細ページを再描画
  revalidatePath(`/tickets/${ticketId}`);
}

// 注: コメント追加処理は POST /api/tickets/[id]/comments (Route Handler) に統合した。
// Server Action の既定 1MB ボディ上限ではスマホ写真添付 (10MB × 5 枚) を扱えないため、
// 同じロジックを Route Handler に置いて UI / API 双方の入口を一本化している。

// ステータス変更を依頼者へメールで通知する内部ヘルパー (ベストエフォート / 副作用は send のみ)。
// 例外は呼び出し側に伝播させず、ログに残して握り潰す: メール送信の失敗でチケット更新が
// 「保存できたのに 500 が返る」事態を避けるため。
async function sendStatusChangedEmailToRequester(args: {
  ticketId: string; // 対象チケット ID (URL 構築用)
  ticketTitle: string; // チケット件名 (メール本文用)
  creatorId: string; // 起票者ユーザー ID (メールアドレス取得用)
  oldStatus: TicketStatus; // 変更前のステータス (ラベル変換用)
  newStatus: TicketStatus; // 変更後のステータス (ラベル変換用)
  mode: import('@/domain/types').TenantMode; // テナント mode (ラベル変換で Lite/Pro を切替)
}): Promise<void> {
  const { ticketId, ticketTitle, creatorId, oldStatus, newStatus, mode } = args;
  try {
    // 起票者 (依頼者) のメールアドレスをユーザーリポジトリから引く
    const creator = await repos.users.findById(creatorId);
    // 依頼者が見つからない / メール未設定なら送りようがないのでスキップ
    if (!creator?.email) return;
    // ベース URL を解決する (production で NEXTAUTH_URL 未設定なら throw → 下で握る)
    const baseUrl = resolveAppBaseUrl();
    // チケット詳細ページへの導線 URL を組み立てる
    const ticketUrl = buildTicketUrl(baseUrl, ticketId);
    // ステータスの日本語ラベルを取得する (Lite/Pro どちらのモードかに応じて切替)
    const oldStatusLabel = getStatusLabel(oldStatus, mode);
    const newStatusLabel = getStatusLabel(newStatus, mode);
    // ステータス変更メールの件名 / テキスト / HTML を純粋ヘルパーで生成する
    const { subject, text, html } = renderTicketStatusChangedEmail({
      ticketTitle,
      ticketUrl,
      oldStatusLabel,
      newStatusLabel,
    });
    // 設定された EmailSender (console / smtp) 経由でメール送信
    await getEmailSender().send({ to: creator.email, subject, text, html });
  } catch (err) {
    // 送信失敗はサーバログに残すだけ (アプリ内通知は既に成立している)
    console.error('[updateTicketStatus] 依頼者宛ステータス変更メール送信に失敗しました', err);
  }
}
