// 履歴項目の種類 (status/priority/assignee/escalation) を示す型をインポート
import type { HistoryField } from '@/domain/types';

// 履歴 1 件を記録する際に渡す入力値
export interface RecordHistoryInput {
  ticketId: string; // どのチケットの履歴か
  changedById: string; // 変更を行ったユーザー ID
  field: HistoryField; // 変更項目の種類
  oldValue: string | null; // 変更前の値 (null 可)
  newValue: string | null; // 変更後の値 (null 可)
}

// 監査ログ一覧で使う拡張型 (関連するユーザー名・チケット件名を含む)
export interface TicketHistoryWithRefs {
  id: string; // 履歴 ID
  ticketId: string; // 対象チケット ID
  ticketTitle: string; // 対象チケット件名 (表示用)
  changedById: string; // 変更者 ID
  changedByName: string; // 変更者氏名 (表示用)
  field: string; // 変更された項目 (HistoryField)
  oldValue: string | null; // 変更前の値
  newValue: string | null; // 変更後の値
  createdAt: Date; // 変更日時
}

// 一覧取得時のフィルター条件
export interface HistoryListFilter {
  tenantId: string; // テナントスコープ (必須。クロステナント漏洩防止)
  limit?: number; // 取得件数上限 (既定 100、最大 500)
  offset?: number; // スキップ件数 (ページネーション)
  // §4.2 フォローアップ再訪 (2026-07-10, §4.2.1): この日時より前 (createdAt <) の行だけを対象にする
  // キーセットページネーション用カーソル。監査ログ画面が「もっと見る」で古い履歴を辿るために使う。
  // TicketHistory と SettingsAuditLog という 2 種類の時系列を日時でマージ表示する都合上、
  // offset だけでは「マージ後の何件目か」を正しく指定できない (どちらの種類が何件ずつ含まれるかは
  // ページごとに変わるため)。カーソルは両リポジトリで同じ createdAt 境界値を渡すことで解決する。
  before?: Date;
}

// チケット履歴書き込み用リポジトリの契約 (port)
export interface TicketHistoryRepository {
  record(input: RecordHistoryInput): Promise<void>; // 履歴を 1 件追加する
  // Phase 4: テナント全体の変更履歴を監査ログとして取得する (管理者専用)
  findAllByTenant(filter: HistoryListFilter): Promise<TicketHistoryWithRefs[]>;
}
