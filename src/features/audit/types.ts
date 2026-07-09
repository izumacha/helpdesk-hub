// 監査ログ画面 (/audit) が表示する行の統一型。
// §4.2 フォローアップ: 従来は TicketHistory (チケットの状態/優先度/担当者/エスカレーション変更)
// しか表示していなかったが、SSO/LINE 連携/通知チャネル設定の変更も同じ一覧・CSV エクスポートに
// 混ぜて表示するため、画面/エクスポートボタンの双方が参照する共通の行型をここに定義する。
import type { SettingsAuditAction } from '@/domain/types';

// チケット変更履歴 1 行 (従来の TicketHistoryWithRefs 相当)
export interface TicketAuditRow {
  kind: 'ticket'; // 行の種別判別用タグ
  id: string; // 履歴 ID
  createdAt: Date; // 変更日時
  actorName: string; // 変更者氏名
  ticketId: string; // 対象チケット ID
  ticketTitle: string; // 対象チケット件名 (表示用)
  field: string; // 変更された項目 (HistoryField)
  oldValue: string | null; // 変更前の値
  newValue: string | null; // 変更後の値
}

// 設定変更監査ログ 1 行 (SettingsAuditLogWithRefs 相当)
export interface SettingsAuditRow {
  kind: 'settings'; // 行の種別判別用タグ
  id: string; // 監査ログ ID
  createdAt: Date; // 操作日時
  actorName: string; // 操作者氏名
  action: SettingsAuditAction; // 実行された操作の種別
}

// 監査ログ一覧・CSV エクスポートが扱う行の判別共用型
export type AuditFeedRow = TicketAuditRow | SettingsAuditRow;
