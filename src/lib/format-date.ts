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

// 'YYYY-MM-DD' 形式の文字列を「その日の JST 終端 (23:59:59.999)」を表す Date に変換する関数
// - サーバが UTC/JST どちらで動いていても結果が変わらないよう、明示的に +09:00 オフセットを付与する
// - 失敗 (形式不正・実在しない日付) 時は null を返す。呼び出し側は事前に Zod 検証済みの値を渡す前提
export function endOfDayJST(yyyyMmDd: string): Date | null {
  // 入力形式チェック (Zod 側でも検証しているがダブルセーフ)
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyyMmDd);
  if (!m) return null;
  // 年・月・日を数値化 (groups は regex マッチで保証されているので decimal parse)
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  // ISO 8601 形式の文字列を +09:00 オフセット付きで組み立てる
  // 例: 2026-05-17 → 2026-05-17T23:59:59.999+09:00 (UTC では 2026-05-17T14:59:59.999Z)
  const d = new Date(`${yyyyMmDd}T23:59:59.999+09:00`);
  // 不正な値 (パース失敗) は NaN になる
  if (Number.isNaN(d.getTime())) return null;
  // JS の Date は 2026-02-31 のような不正日付をロールオーバーで受け入れてしまう
  // (例: 2026-02-31 → 2026-03-03)。入力した y/m/d と Date 側の y/m/d (JST) が
  // 一致するかを確認することで実在しない日付を弾く
  // 'Asia/Tokyo' で年月日を取り出して比較する (サーバ TZ 非依存)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  // formatToParts は型ごとに分解した配列を返す。値だけ取り出して数値比較する
  const valueOf = (type: 'year' | 'month' | 'day') =>
    Number(parts.find((p) => p.type === type)?.value);
  // 一致しなければロールオーバーが起きている = 不正日付
  if (valueOf('year') !== year || valueOf('month') !== month || valueOf('day') !== day) {
    return null;
  }
  return d;
}
