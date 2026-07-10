// 監査ログ系リポジトリ (TicketHistoryRepository / SettingsAuditLogRepository) が
// Prisma / メモリの両アダプタで共通に使うページネーション定数とクランプ処理。
// /code-review ultra 指摘対応: 同一の定数・クランプ式が 4 ファイル (両リポジトリ × 両アダプタ)
// に一字一句複製されていたため (CLAUDE.md §6 の「2〜3 箇所目で共通化する」を超過)、
// ここに集約する。

// キーセットページネーションのカーソル型 (ports 層で定義。§4.2.1 フォローアップ参照)
import type { AuditPaginationCursor } from '@/data/ports/audit-pagination';

// 取得件数の既定値 (一画面に収まる量)
export const AUDIT_DEFAULT_LIMIT = 100;
// 取得件数の上限 (パフォーマンス保護: 一覧で大量データを返さないようにする)
export const AUDIT_MAX_LIMIT = 500;

// 呼び出し側が指定した limit を [1, AUDIT_MAX_LIMIT] の範囲にクランプして返す。
// 未指定なら AUDIT_DEFAULT_LIMIT を使う (DoS・リソース枯渇防止)
export function resolveAuditLimit(requested: number | undefined): number {
  return Math.min(requested ?? AUDIT_DEFAULT_LIMIT, AUDIT_MAX_LIMIT);
}

// §4.2.1 フォローアップ再訪 (2026-07-10): 行 (createdAt, id) がカーソルより「前」(新しい順で
// カーソルより後ろ側 = 古い側) かどうかを判定する共通ヘルパー。メモリアダプタ 2 箇所 (ticket-history /
// settings-audit-log) が同じ複合比較ロジックを重複実装しないよう集約する
// (Prisma アダプタは同じ意味の OR 条件を DB クエリとして持つため対象外)。
// 対象: createdAt < cursor.createdAt、または (createdAt === cursor.createdAt かつ id < cursor.id)
export function isBeforeAuditCursor(
  createdAt: Date,
  id: string,
  cursor: AuditPaginationCursor,
): boolean {
  const diff = createdAt.getTime() - cursor.createdAt.getTime();
  if (diff !== 0) return diff < 0;
  return id < cursor.id;
}
