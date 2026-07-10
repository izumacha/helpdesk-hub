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

// マージ順序の基準: createdAt が同値のとき 'ticket' を必ず 'settings' より前に並べる
// (AuditPaginationCursor のコメント、audit/page.tsx のマージ処理と同じ取り決めを共有する)
const KIND_ORDER: Record<AuditPaginationCursor['kind'], number> = { ticket: 0, settings: 1 };

// §4.2.1 フォローアップ再訪 (2026-07-10): 行 (createdAt, ownKind, id) がカーソルより「前」
// (新しい順でカーソルより後ろ側 = 古い側、まだ表示していない側) かどうかを判定する共通ヘルパー。
// メモリアダプタ 2 箇所 (ticket-history / settings-audit-log) が同じ複合比較ロジックを重複実装
// しないよう集約する (Prisma アダプタは同じ意味の OR 条件を DB クエリとして持つため対象外)。
//
// /code-review ultra 再指摘対応: 当初は id だけで同一 createdAt のタイブレークをしていたが、
// TicketHistory と SettingsAuditLog という由来の異なる 2 テーブルの id を直接比較すると、
// 「まだ 1 件も表示していないテーブル」の行が誤って除外されうる回帰があった。ownKind (この行が
// どちらのテーブル由来か) と cursor.kind を KIND_ORDER で比較し、以下の 3 パターンに分岐する:
//   - createdAt が異なる: その大小だけで判定する (通常のキーセット比較)
//   - createdAt が同値かつ ownKind === cursor.kind: 同じテーブル内の続きなので id で比較する
//   - createdAt が同値かつ ownKind が cursor.kind より「後」の並び順: そのテーブルの当該 createdAt
//     の行はまだ 1 件も表示されていないはずなので、id に関わらず全件を対象にする (取りこぼし防止)
//   - createdAt が同値かつ ownKind が cursor.kind より「前」の並び順: そのテーブルの当該 createdAt
//     の行は (マージ順序上) 必ず先に出尽くしているはずなので、全件を除外する
export function isBeforeAuditCursor(
  createdAt: Date,
  ownKind: AuditPaginationCursor['kind'],
  id: string,
  cursor: AuditPaginationCursor,
): boolean {
  const diff = createdAt.getTime() - cursor.createdAt.getTime();
  if (diff !== 0) return diff < 0;
  if (ownKind === cursor.kind) return id < cursor.id;
  return KIND_ORDER[ownKind] > KIND_ORDER[cursor.kind];
}
