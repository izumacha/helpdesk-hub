// 監査ログ画面 (/audit) が表示する行の統一型。
// §4.2 フォローアップ: 従来は TicketHistory (チケットの状態/優先度/担当者/エスカレーション変更)
// しか表示していなかったが、SSO/LINE 連携/通知チャネル設定の変更も同じ一覧・CSV エクスポートに
// 混ぜて表示するため、画面/エクスポートボタンの双方が参照する共通の行型をここに定義する。
import type { SettingsAuditAction } from '@/domain/types';

// チケット変更履歴 1 行 (従来の TicketHistoryWithRefs 相当)
export interface TicketAuditRow {
  kind: 'ticket';
  id: string;
  createdAt: Date;
  actorName: string; // 変更者氏名
  ticketId: string;
  ticketTitle: string;
  field: string; // HistoryField
  oldValue: string | null;
  newValue: string | null;
}

// 設定変更監査ログ 1 行 (SettingsAuditLogWithRefs 相当)
export interface SettingsAuditRow {
  kind: 'settings';
  id: string;
  createdAt: Date;
  actorName: string; // 操作者氏名
  action: SettingsAuditAction;
}

// 監査ログ一覧・CSV エクスポートが扱う行の判別共用型
export type AuditFeedRow = TicketAuditRow | SettingsAuditRow;
