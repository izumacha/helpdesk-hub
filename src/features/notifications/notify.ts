/**
 * Post-commit notification fan-out.
 *
 * The notification *row* is expected to already have been written through the
 * repository layer (typically inside `uow.run`). This helper handles the
 * non-transactional side-effects that used to live in `createNotification`:
 * - Invalidate the cached unread count.
 * - Read the fresh count.
 * - Broadcast it over SSE.
 */

// Next.js のキャッシュタグ無効化 API
import { revalidateTag } from 'next/cache';
// リポジトリ束 (未読件数取得に使用)
import { repos } from '@/data';
// SSE の送信関数
import { broadcast } from '@/lib/sse-subscribers';

// 指定ユーザー × テナントの未読件数を再計算して配信する
// 通知は必ずテナント単位なので、count 取得時も同じ tenantId スコープで集計する
export async function broadcastUnreadCount(userId: string, tenantId: string): Promise<void> {
  // キャッシュされた未読件数を無効化 (次の取得で再計算させる)
  revalidateTag(`notification-count-${userId}`);
  // 最新件数を直接 DB から数える (tenantId スコープ)
  const count = await repos.notifications.countUnread(userId, tenantId);
  // 取得した件数を SSE で即時配信
  broadcast(userId, count);
}

// 複数ユーザー向けにまとめて未読件数を再配信するヘルパー (全員が同一テナント前提)
// チケット起点の通知扇形 (担当者通知/エスカレーション通知/コメント通知) ではチケットの
// テナントに属するユーザーだけが対象なので、テナントは 1 つで足りる
export async function broadcastUnreadCountToMany(
  userIds: Iterable<string>,
  tenantId: string,
): Promise<void> {
  // 重複 ID を除去した配列に変換 (同じユーザーに 2 度配信しないため)
  const unique = Array.from(new Set(userIds));
  // 並列に全ユーザーへ配信 (同じテナントを伝搬)
  await Promise.all(unique.map((uid) => broadcastUnreadCount(uid, tenantId)));
}

// 「新規チケット 1 件」をエージェント群へアプリ内通知するベストエフォート・ヘルパー。
// LINE 取り込み・メール取り込みの inbound Webhook が、単一チケットに紐づく
// 'imported' 通知をエージェント全員へ送る処理を共有する (CLAUDE.md §6 DRY:
// 2 系統目のメール取り込みを実装した時点でこの形が 2 箇所目の重複になったため抽出)。
// CSV インポートは複数件をまとめた 1 通のバッチ通知 (ticketId なし) で形が異なるため対象外。
export async function notifyAgentsOfNewTicket(params: {
  tenantId: string; // 通知のテナントスコープ
  ticketId: string; // 紐付ける新規チケット ID
  message: string; // 通知文言 (呼び出し元でチャネルごとに組み立て済み)
  targets: ReadonlyArray<{ id: string }>; // 通知対象エージェント一覧 (呼び出し元で自己除外済み)
  logPrefix: string; // ログの先頭に付ける識別子 (例: '[POST /api/inbound/email]')
}): Promise<void> {
  // 分割代入で個々のパラメータを取り出す
  const { tenantId, ticketId, message, targets, logPrefix } = params;
  // 通知対象が居なければ何もしない (早期リターン)
  if (targets.length === 0) return;
  // 各エージェントへ通知を作成する。allSettled で 1 件失敗しても他を止めない
  const notifyResults = await Promise.allSettled(
    targets.map((a) =>
      repos.notifications.create({
        userId: a.id, // 通知受信者: 各エージェント
        type: 'imported', // inbound チャネル (LINE/メール) からの新規起票通知は 'imported' を使う
        message, // 呼び出し元が組み立てた通知文言
        ticketId, // 紐付けチケット
        tenantId, // テナントスコープ
      }),
    ),
  );
  // 通知作成に成功したエージェント ID だけを SSE 配信対象にする (失敗分は DB レコードが無いためスキップ)
  const succeededIds = targets
    .filter((_, i) => notifyResults[i]?.status === 'fulfilled')
    .map((a) => a.id);
  // 失敗件数を算出する (成功件数との差分)
  const failedCount = targets.length - succeededIds.length;
  if (failedCount > 0) {
    // 失敗件数だけログに残す (チケット起票自体は完了済みのため処理は継続する)
    console.warn(`${logPrefix} ${failedCount} notification(s) failed to create for new ticket`, ticketId);
  }
  // 未読カウントを SSE で即時配信して通知ベルに反映させる (成功分のみ)
  if (succeededIds.length > 0) {
    await broadcastUnreadCountToMany(succeededIds, tenantId).catch((err) => {
      // SSE 配信失敗はバッジ更新が遅れるだけ。ログのみ残して続行する
      console.warn(`${logPrefix} failed to broadcast unread count`, err);
    });
  }
}
