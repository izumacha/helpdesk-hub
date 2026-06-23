/**
 * チケットの短縮参照番号 (受付番号) を組み立てる共有ヘルパー。
 *
 * チケット ID は cuid なのでそのままだと長い。画面のチケット詳細ヘッダと、メール
 * (初回メール起票の受領自動返信) で「同じ表記の受付番号」を使うため、1 か所に集約する (§6 一元管理)。
 * 別々に `id.slice(0, 8)` を直書きすると、片方だけ桁数を変えたときに表記がズレるのを防ぐ。
 */

// 短縮 ID として使う先頭文字数。cuid 先頭 8 文字で日常の識別には十分な一意性がある。
export const TICKET_REF_SHORT_LENGTH = 8;

// チケット ID から表示用の参照番号 "#xxxxxxxx" を作る純粋関数。
export function formatTicketRef(ticketId: string): string {
  // 先頭 N 文字を切り出し、頭に "#" を付けて「受付番号」らしい見た目にする
  return `#${ticketId.slice(0, TICKET_REF_SHORT_LENGTH)}`;
}
