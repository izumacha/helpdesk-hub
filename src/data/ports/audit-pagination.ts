// 監査ログ系リポジトリ (TicketHistoryRepository / SettingsAuditLogRepository) が共有する
// キーセットページネーションのカーソル型。
//
// §4.2.1 フォローアップ再訪 (2026-07-10): 当初 createdAt だけをカーソルにしていたが、
// /code-review ultra 指摘対応: 同一ミリ秒に複数行が記録された場合 (バルク CSV インポート・
// 同時多発の設定変更等) に、ページ境界をまたぐ同時刻の行が「前ページで表示済み」とも
// 「次ページの対象」とも判定できず、一部の行が永久に読み込めなくなる (監査ログの取りこぼし)。
// createdAt が同値の行同士を一意に順序付けるため id を第 2 キーに加えた複合カーソルにした。
//
// さらに /code-review ultra 再指摘対応: TicketHistory と SettingsAuditLog という 2 つの独立した
// テーブルをマージ表示するこの画面では、id だけでは不十分だった。両テーブルの id は同じ cuid()
// 採番だが由来が別々のため、片方のテーブル (例: TicketHistory) の id を、もう片方のテーブル
// (SettingsAuditLog) の id 比較にそのまま使うと、実際にはまだ 1 件も表示していない設定変更監査
// ログが「id が cursor 以上」というだけの理由で誤って除外され続け、同じ取りこぼしが別の形で
// 再発しうる。マージ順序の決定的な基準である kind (どちらのテーブル由来か) を第 2 キーに、
// id を第 3 キーにした 3 要素カーソルにする。
export interface AuditPaginationCursor {
  createdAt: Date; // 基準日時 (最優先のソートキー)
  // マージ順序の基準: createdAt が同値のとき 'ticket' (TicketHistory) を必ず 'settings'
  // (SettingsAuditLog) より前に並べる、と画面側 (audit/page.tsx) のマージ処理と取り決めておく。
  // これにより「まだ 1 件も表示していないテーブル」を誤って除外しない判定ができる
  kind: 'ticket' | 'settings';
  id: string; // 同一 createdAt かつ同一 kind の行同士を一意に順序付けるタイブレーカー
}
