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

// 日本時間の年月日を 'YYYY-MM-DD' 形式 (機械可読・ゼロ埋め済み) で文字列化する関数。
// CSV エクスポート等、人間が読む formatDateJP (ja-JP ロケール、非ゼロ埋め) とは別に、
// そのまま再パース可能な形式が必要な用途向け。
// en-CA ロケールは yyyy-mm-dd 形式で返すため (endOfDayJST の Intl.DateTimeFormat と同じ手法)、
// そのまま ISO 風の文字列として使える。
export function formatDateISO(date: Date): string {
  return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' });
}

// JST の年月日時分秒をゼロ埋め済みの数値で取り出す内部ヘルパー。
// formatDateTimeISO (組み立て) と parseDateTimeJST (ロールオーバー検知の往復確認) の
// 両方が同じ Intl.DateTimeFormat 設定を必要とするため、2 箇所目の重複が生じた時点で
// 共通化した (§6 DRY)。hourCycle: 'h23' で 24 時間表記を明示し、12 時間表記 + AM/PM の
// 混入を防ぐ。
function getJSTDateTimeParts(date: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  // 種別ごとに値を取り出すヘルパー (欠損時は 0。通常は発生しない)
  const valueOf = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: valueOf('year'),
    month: valueOf('month'),
    day: valueOf('day'),
    hour: valueOf('hour'),
    minute: valueOf('minute'),
    second: valueOf('second'),
  };
}

// 日本時間の日時を 'YYYY-MM-DD HH:mm:ss' 形式 (機械可読・ゼロ埋め済み) で文字列化する関数。
// CSV エクスポートの「起票日時」列など、そのまま再パース可能な形式が必要な用途向け
// (formatDateISO の日時版。formatDateTimeJP は ja-JP ロケールの非ゼロ埋め表示専用で再パース不可)。
// フォローアップ (2026-07-15 #3): 「起票日時」がエクスポートのみで再インポートに未対応だったため、
// この関数と対になる parseDateTimeJST を追加し、往復可能にした
export function formatDateTimeISO(date: Date): string {
  // JST の年月日時分秒をゼロ埋め済みで取り出す (endOfDayJST と同じ手法)
  const { year, month, day, hour, minute, second } = getJSTDateTimeParts(date);
  // ゼロ埋め用のヘルパー (2 桁固定)
  const pad = (n: number) => String(n).padStart(2, '0');
  // 'YYYY-MM-DD HH:mm:ss' 形式に組み立てる
  return `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

// 'YYYY-MM-DD HH:mm:ss' 形式の文字列を JST の時刻として解釈した Date に変換する関数
// (formatDateTimeISO の逆変換)。endOfDayJST と同じく明示的に +09:00 オフセットを付与し、
// サーバの実行タイムゾーンが UTC/JST どちらでも結果が変わらないようにする。
// - 失敗 (形式不正・実在しない日時) 時は null を返す
export function parseDateTimeJST(str: string): Date | null {
  // 入力形式チェック (ゼロ埋め済みの厳密な YYYY-MM-DD HH:mm:ss のみ許可)
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(str);
  if (!m) return null;
  // 年月日時分秒を数値化する (m[0] は全体マッチなので m[1] から)
  const [, yStr, moStr, dStr, hStr, miStr, sStr] = m;
  const year = Number(yStr);
  const month = Number(moStr);
  const day = Number(dStr);
  const hour = Number(hStr);
  const minute = Number(miStr);
  const second = Number(sStr);
  // ISO 8601 形式の文字列を +09:00 オフセット付きで組み立てる
  const d = new Date(`${yStr}-${moStr}-${dStr}T${hStr}:${miStr}:${sStr}.000+09:00`);
  // 不正な値 (パース失敗) は NaN になる
  if (Number.isNaN(d.getTime())) return null;
  // JS の Date は不正な日時をロールオーバーで受け入れてしまう (例: 25 時 → 翌日 1 時)。
  // 入力した年月日時分秒と Date 側 (JST) の値が一致するかを確認して実在しない日時を弾く
  // (endOfDayJST と同じ Intl.DateTimeFormat による往復確認パターン)
  const roundTrip = getJSTDateTimeParts(d);
  if (
    roundTrip.year !== year ||
    roundTrip.month !== month ||
    roundTrip.day !== day ||
    roundTrip.hour !== hour ||
    roundTrip.minute !== minute ||
    roundTrip.second !== second
  ) {
    return null;
  }
  return d;
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

// 指定した日時が属する「JST の月初 00:00:00.000」を表す Date を返す関数
// - サーバの実行タイムゾーンが UTC/JST どちらでも結果が変わらないよう、'Asia/Tokyo' で
//   年・月を取り出してから明示的に +09:00 オフセット付きで組み立てる
// - 月間チケット上限の集計 (src/lib/tenant-plan.ts) など、JST の暦月境界で
//   件数を数えたい箇所から共通で使う (endOfDayJST と同じ Intl.DateTimeFormat パターン)
// - 引数省略時は現在時刻 (Date.now()) を基準にする
export function startOfMonthJST(date: Date = new Date()): Date {
  // 'Asia/Tokyo' で年・月だけを取り出す (日は月初固定の 01 なので不要)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date);
  // parts から年・月の文字列を取り出すヘルパー
  const valueOf = (type: 'year' | 'month') => parts.find((p) => p.type === type)?.value;
  const year = valueOf('year');
  const month = valueOf('month');
  // year/month が取れない (実行環境の Intl 実装異常等) 場合は fail-closed で例外にする。
  // 呼び出し側 (集計処理) が誤って「無制限」扱いにならないよう、黙ってフォールバックしない。
  if (!year || !month) {
    throw new Error('startOfMonthJST: Asia/Tokyo の年月を取得できませんでした');
  }
  // YYYY-MM-01T00:00:00.000+09:00 を組み立てて JST の月初を表す Date にする
  return new Date(`${year}-${month}-01T00:00:00.000+09:00`);
}
