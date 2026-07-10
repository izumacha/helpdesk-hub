// 監査ログ系リポジトリ (TicketHistoryRepository / SettingsAuditLogRepository) が共有する
// キーセットページネーションのカーソル型。
//
// §4.2.1 フォローアップ再訪 (2026-07-10): 当初 createdAt だけをカーソルにしていたが、
// /code-review ultra 指摘対応: 同一ミリ秒に複数行が記録された場合 (バルク CSV インポート・
// 同時多発の設定変更等) に、ページ境界をまたぐ同時刻の行が「前ページで表示済み」とも
// 「次ページの対象」とも判定できず、一部の行が永久に読み込めなくなる (監査ログの取りこぼし)。
// createdAt が同値の行同士を一意に順序付けるため id を第 2 キーに加えた複合カーソルにする
// (id 自体に意味は無く、決定的な全順序を作るためだけに使う)。
export interface AuditPaginationCursor {
  createdAt: Date; // 基準日時 (この値より前、または同値かつ id が cursor より小さい行を対象にする)
  id: string; // 同一 createdAt 内の順序を一意に決めるタイブレーカー
}
