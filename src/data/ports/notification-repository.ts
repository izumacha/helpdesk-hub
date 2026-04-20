// ドメイン型 (通知本体/種別) をインポート
import type { Notification, NotificationType } from '@/domain/types';

// 通知を作成するときに渡す入力値
export interface CreateNotificationInput {
  userId: string; // 受信者 ID
  type: NotificationType; // 通知の種類
  message: string; // 表示文言
  ticketId?: string | null; // 関連チケット ID (任意)
}

// 一覧表示用の通知アイテム (関連チケットの一部情報を同梱)
export interface NotificationListItem extends Notification {
  ticket: { id: string; title: string } | null; // 関連チケットの要約 (なければ null)
}

// 通知ストアの契約 (port)
export interface NotificationRepository {
  create(input: CreateNotificationInput): Promise<Notification>; // 通知を 1 件作成
  countUnread(userId: string): Promise<number>; // 未読件数を取得
  list(userId: string, opts: { limit: number }): Promise<NotificationListItem[]>; // 一覧取得
  markAllRead(userId: string): Promise<void>; // 全通知を既読にする
}
