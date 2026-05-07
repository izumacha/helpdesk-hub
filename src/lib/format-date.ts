// 日本時間 (Asia/Tokyo) を明示してフォーマットする共通関数群
// サーバ/ブラウザの OS タイムゾーンに依存せず常に JST 表示を保証する

// 年月日と時分秒まで日本語ロケール + 日本時間で文字列化する関数
export function formatDateTimeJP(date: Date): string {
  // toLocaleString に locale と timeZone を渡して JST へ変換する
  return date.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

// 年月日のみを日本語ロケール + 日本時間で文字列化する関数
export function formatDateJP(date: Date): string {
  // toLocaleDateString に locale と timeZone を渡して JST へ変換する
  return date.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });
}
