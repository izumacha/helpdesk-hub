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
// ステータス遷移が許可されているか判定するドメイン関数
import { isValidTransition } from '@/domain/ticket-status';
// 型のみインポート (優先度/ステータス)
import type { Priority, TicketStatus } from '@/domain/types';
// レート制限 (連打防止) の共通ヘルパー
import { enforceRateLimit } from '@/lib/rate-limit';
// Zod スキーマ (コメント本文/エスカレーション理由の検証用)
import { commentBodySchema, escalationReasonSchema } from '@/lib/validations/ticket';
// next-auth のセッション型
import type { Session } from 'next-auth';

// セッションがログイン済みであることを保証するアサーション関数
function assertAuthenticatedUser(session: Session | null): asserts session is Session {
  // ユーザー ID が無ければ未ログインとみなしてエラー
  if (!session?.user?.id) throw new Error('Unauthorized');
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
  // 10 秒あたり 10 回までに制限 (チケット単位)
  enforceRateLimit(`ticket-status:${session.user.id}:${ticketId}`, { limit: 10, windowMs: 10_000 });

  // 1 トランザクションでチケット更新と履歴記録を実行
  await uow.run(async (r) => {
    // 対象チケットを取得
    const ticket = await r.tickets.findById(ticketId);
    // 見つからなければエラー
    if (!ticket) throw new Error('チケットが見つかりません');
    // 変更前後が同じなら何もしない (冪等)
    if (ticket.status === newStatus) return;
    // 遷移表で許可されていない変更は拒否
    if (!isValidTransition(ticket.status, newStatus)) {
      throw new Error(
        `ステータスを「${ticket.status}」から「${newStatus}」に変更することはできません`,
      );
    }

    // Resolved に遷移したら解決日時を現在時刻に、Resolved から離れる場合はクリア、それ以外は据え置き
    const resolvedAt =
      newStatus === 'Resolved'
        ? new Date()
        : ticket.status === 'Resolved'
          ? null
          : ticket.resolvedAt;

    // ステータスと解決日時を更新
    await r.tickets.updateStatus(ticketId, newStatus, resolvedAt);
    // 変更履歴を残す (誰が/どの項目を/旧値→新値)
    await r.history.record({
      ticketId,
      changedById: session.user.id,
      field: 'status',
      oldValue: ticket.status,
      newValue: newStatus,
    });
  });

  // チケット詳細ページのキャッシュを無効化して再描画
  revalidatePath(`/tickets/${ticketId}`);
}

// チケットの優先度を変更するサーバーアクション
export async function updateTicketPriority(ticketId: string, newPriority: Priority) {
  // セッション取得
  const session = await auth();
  // エージェント以上のみ実行可
  assertAgentRole(session);
  // 10 秒あたり 10 回までに制限
  enforceRateLimit(`ticket-priority:${session.user.id}:${ticketId}`, {
    limit: 10,
    windowMs: 10_000,
  });

  // 1 トランザクションで更新と履歴記録
  await uow.run(async (r) => {
    // チケットを取得
    const ticket = await r.tickets.findById(ticketId);
    // 無ければエラー
    if (!ticket) throw new Error('チケットが見つかりません');
    // 変更無しならスキップ
    if (ticket.priority === newPriority) return;

    // 優先度を更新
    await r.tickets.updatePriority(ticketId, newPriority);
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
  // 10 秒あたり 10 回までに制限
  enforceRateLimit(`ticket-assignee:${session.user.id}:${ticketId}`, {
    limit: 10,
    windowMs: 10_000,
  });

  // チケット (既存担当者含む) と新担当者候補を並列で取得
  const [ticket, newUser] = await Promise.all([
    repos.tickets.findByIdWithRefs(ticketId),
    newAssigneeId ? repos.users.findById(newAssigneeId) : Promise.resolve(null),
  ]);

  // チケットが無ければエラー
  if (!ticket) throw new Error('チケットが見つかりません');
  // 担当者を付ける場合は相手の存在とロールを確認
  if (newAssigneeId) {
    // ユーザー未存在 or エージェント/管理者でない場合は拒否理由を特定
    const reason = !newUser ? 'not-found' : !isAgent(newUser.role) ? 'not-agent' : null;
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
    // 担当者を差し替え (解除は null)
    await r.tickets.updateAssignee(ticketId, newAssigneeId);
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
      });
    }
  });

  // 新担当者に未読件数を SSE で即時配信
  if (newAssigneeId) await broadcastUnreadCount(newAssigneeId);
  // 詳細ページのキャッシュを無効化
  revalidatePath(`/tickets/${ticketId}`);
}

// チケットをエスカレーション (上位対応へ引き上げ) するサーバーアクション
export async function escalateTicket(ticketId: string, reason: string) {
  // セッション取得
  const session = await auth();
  // エージェント以上のみ実行可
  assertAgentRole(session);
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

  // チケット本体と通知対象の全エージェント ID 一覧を並列取得
  const [ticket, agentIds] = await Promise.all([
    repos.tickets.findById(ticketId),
    repos.users.listAgentIds(),
  ]);

  // チケットが無ければエラー
  if (!ticket) throw new Error('チケットが見つかりません');
  // Escalated への遷移が許可されているか確認
  if (!isValidTransition(ticket.status, 'Escalated')) {
    throw new Error(`現在のステータス「${ticket.status}」からエスカレーションできません`);
  }

  // エスカレーション発生時刻
  const now = new Date();
  // メッセージ組み立てに使うタイトルを取り出す
  const { title } = ticket;

  // マーク・履歴・エージェント一斉通知を 1 トランザクションで実行
  await uow.run(async (r) => {
    // チケットに Escalated フラグと理由/日時を書き込む
    await r.tickets.markEscalated(ticketId, { reason: trimmedReason, at: now });
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
        }),
      ),
    );
  });

  // 全エージェントへ未読件数を一斉配信
  await broadcastUnreadCountToMany(agentIds);
  // 詳細ページを再描画
  revalidatePath(`/tickets/${ticketId}`);
}

// チケットにコメントを追加するサーバーアクション
export async function addComment(ticketId: string, body: string) {
  // セッション取得
  const session = await auth();
  // コメントはログイン済みなら (依頼者でも) 可
  assertAuthenticatedUser(session);
  // 60 秒あたり 20 件までに制限
  enforceRateLimit(`ticket-comment:${session.user.id}`, { limit: 20, windowMs: 60_000 });

  // 本文を Zod で検証
  const parsedBody = commentBodySchema.safeParse(body);
  // 検証失敗なら日本語エラー
  if (!parsedBody.success) {
    throw new Error(parsedBody.error.issues[0]?.message ?? 'コメントが不正です');
  }
  // 検証済み本文を取り出す
  const trimmedBody = parsedBody.data;

  // 対象チケットを取得
  const ticket = await repos.tickets.findById(ticketId);
  // 無ければエラー
  if (!ticket) throw new Error('チケットが見つかりません');

  // 投稿者 ID とロールをまとめて抽出
  const authorId = session.user.id;
  const authorIsAgent = isAgent(session.user.role);
  // エージェント、または自分が作成したチケットならコメント可
  const canComment = authorIsAgent || ticket.creatorId === authorId;
  // 権限が無ければ拒否
  if (!canComment) {
    throw new Error('このチケットへのコメント権限がありません');
  }

  // 通知対象 (依頼者/担当者/全エージェント など) を算出
  const recipientIds = await resolveCommentRecipients(ticket, authorId, authorIsAgent);
  // 通知メッセージ (タイトル入り)
  const message = `チケット「${ticket.title}」に新しいコメントが追加されました`;

  // コメント保存と通知生成を 1 トランザクションで実行
  await uow.run(async (r) => {
    // コメント本体を保存
    await r.comments.create({
      ticketId,
      authorId,
      body: trimmedBody,
    });
    // 対象者全員に通知を作成
    await Promise.all(
      recipientIds.map((id) =>
        r.notifications.create({
          userId: id,
          type: 'commented',
          message,
          ticketId,
        }),
      ),
    );
  });

  // 通知対象が 1 名以上いれば未読件数を一斉配信
  if (recipientIds.length > 0) await broadcastUnreadCountToMany(recipientIds);
  // 詳細ページのキャッシュを無効化
  revalidatePath(`/tickets/${ticketId}`);
}

// コメント通知の送信先を決定するヘルパー
async function resolveCommentRecipients(
  ticket: { creatorId: string; assigneeId: string | null },
  authorId: string,
  authorIsAgent: boolean,
): Promise<string[]> {
  // 宛先候補を集める配列
  const candidates: string[] = [];
  // エージェントがコメントした場合: 依頼者 (+ 担当者が居れば担当者)
  if (authorIsAgent) {
    candidates.push(ticket.creatorId);
    if (ticket.assigneeId) candidates.push(ticket.assigneeId);
  } else if (ticket.assigneeId) {
    // 依頼者がコメントし担当者が決まっている場合は担当者のみ
    candidates.push(ticket.assigneeId);
  } else {
    // 依頼者がコメントし担当者未定なら全エージェントに通知 (取りこぼし防止)
    candidates.push(...(await repos.users.listAgentIds()));
  }
  // 重複排除し、コメント投稿者自身は除外して返す
  return Array.from(new Set(candidates)).filter((id) => id !== authorId);
}
