// 設定変更監査ログ (SettingsAuditLog) リポジトリの契約 (port)。
// docs/smb-dx-pivot-plan.md §4.2 フォローアップ: 監査ログ画面が TicketHistory (チケットの
// 状態/優先度/担当者/エスカレーション変更) しか表示しておらず、SSO/LINE 連携/通知チャネル
// 設定の変更が監査対象から漏れていたギャップを解消する。

// アクション種別の型
import type { SettingsAuditAction } from '@/domain/types';
// キーセットページネーション用カーソル型 (ticket-history-repository.ts と共有)
import type { AuditPaginationCursor } from './audit-pagination';

// 監査ログを 1 件記録する際に渡す入力値
export interface RecordSettingsAuditInput {
  tenantId: string; // 対象テナント
  // 操作を行ったユーザー。§4.3 フォローアップ (2026-07-10): Stripe Webhook 起因の自動プラン
  // ダウングレードのようにユーザーが介在しないシステム操作は null (システムアクター) を渡す
  actorId: string | null;
  action: SettingsAuditAction; // 実行された操作の種別
}

// 監査ログ一覧で使う拡張型 (関連する操作者名を含む)
export interface SettingsAuditLogWithRefs {
  id: string; // 監査ログ ID
  actorId: string | null; // 操作者 ID (null ならシステム操作)
  actorName: string; // 操作者氏名 (表示用。システム操作は固定ラベルに解決済み)
  action: SettingsAuditAction; // 実行された操作の種別
  createdAt: Date; // 操作日時
}

// 一覧取得時のフィルター条件
export interface SettingsAuditLogListFilter {
  tenantId: string; // テナントスコープ (必須。クロステナント漏洩防止)
  limit?: number; // 取得件数上限 (既定 100、最大 500)
  offset?: number; // スキップ件数 (ページネーション)
  // §4.2 フォローアップ再訪 (2026-07-10, §4.2.1): キーセットページネーション用カーソル。
  // ticket-history-repository.ts の HistoryListFilter.before と同じ理由・同じ規約を共有する
  // (TicketHistory とマージして時系列表示するため offset だけでは正しくページ送りできない。
  // createdAt 単独だと同一ミリ秒の複数行を取りこぼすため id を第 2 キーに持つ複合カーソルにする)
  before?: AuditPaginationCursor;
}

// 設定変更監査ログ書き込み用リポジトリの契約 (port)
export interface SettingsAuditLogRepository {
  record(input: RecordSettingsAuditInput): Promise<void>; // 監査ログを 1 件追加する
  // テナント全体の設定変更監査ログを取得する (管理者専用)
  findAllByTenant(filter: SettingsAuditLogListFilter): Promise<SettingsAuditLogWithRefs[]>;
}
