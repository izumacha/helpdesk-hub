// キーセットカーソルを使った「全履歴 CSV エクスポート」で共通のロジックを集約する。
//
// フォローアップ (2026-07-14 #3 /code-review ultra 指摘対応): GET /api/audit/export
// (§4.2.1/§4.2.2) と GET /api/quarantine/export (§3.7) が、キーセットカーソルを繰り返し
// 前進させて上限件数まで全ページを蓄積するループ（「ちょうど上限に到達したときだけ 1 件
// プローブして誤って truncated と警告しないようにする」判定を含む）と、CSV レスポンスの
// ヘッダー構築（Content-Disposition のファイル名・Cache-Control・X-Truncated/X-Total-Limit）を、
// ほぼ一字一句同じ形で個別に複製していた。fetch-audit-feed-page.ts や rate-limit.ts の
// checkRateLimit が同種の重複を「2〜3 箇所目で共通化する」(§6 DRY) 方針で解消してきた前例に
// 倣い、ここに集約する (2 箇所目の複製が生じた時点での共通化)。

// 1 ページ分の取得結果 (呼び出し側の fetchPage が返す形。TRow/TCursor はデータソースごとに異なる)
export interface CursorExportPage<TRow, TCursor> {
  rows: TRow[]; // このページの行 (最大 pageSize 件)
  hasMore: boolean; // まだ表示していない古い行が残っている可能性があるか
  nextCursor: TCursor | null; // 「次ページ」用のカーソル (hasMore が false なら null)
}

// collectCursorPaginatedRows の戻り値
export interface CursorExportResult<TRow> {
  rows: TRow[]; // 蓄積した全行 (最大 maxRows 件)
  truncated: boolean; // maxRows で打ち切ったかどうか (呼び出し元へ警告するために使う)
}

/**
 * fetchPage を繰り返し呼んでキーセットカーソルを前進させ、maxRows 件まで全ページを蓄積する。
 * maxRows にちょうど到達したときだけ probeForMore で 1 件だけ追加取得し、実際にまだ続きが
 * あるかを確認してから truncated を確定する（「ちょうど limit 件で埋まった」だけの
 * ヒューリスティックで真偽を決めると、テナントの総件数がたまたま maxRows ちょうどだった場合に
 * 「まだ続きがある」と誤って警告してしまうため。/api/audit/export の元実装のコメント参照）。
 *
 * @param maxRows 全体の上限件数 (呼び出し側が pageSize の倍数であることを保証すること)
 * @param fetchPage カーソルを受け取り 1 ページ分を返すコールバック
 * @param probeForMore ちょうど maxRows に達したときだけ呼ばれる、続きの有無を確認する追加取得
 */
export async function collectCursorPaginatedRows<TRow, TCursor>(params: {
  maxRows: number;
  fetchPage: (cursor: TCursor | undefined) => Promise<CursorExportPage<TRow, TCursor>>;
  probeForMore: (nextCursor: TCursor) => Promise<boolean>;
}): Promise<CursorExportResult<TRow>> {
  const { maxRows, fetchPage, probeForMore } = params;
  // 蓄積した行を貯める配列
  const rows: TRow[] = [];
  // 現在のカーソル (未指定 = 最新から)
  let cursor: TCursor | undefined = undefined;
  // 上限で打ち切ったかどうか
  let truncated = false;
  for (;;) {
    // 1 ページ分を取得する
    const page = await fetchPage(cursor);
    // 取得した行を蓄積配列へ追加する
    rows.push(...page.rows);
    // 上限に達したら、まだ続きがあっても打ち切る
    if (rows.length >= maxRows) {
      // ちょうど上限に到達したときだけ、次カーソル以降に本当に行が残っているかを
      // 1 件だけ確認してから truncated を確定する
      truncated = page.hasMore && page.nextCursor ? await probeForMore(page.nextCursor) : false;
      break;
    }
    // 続きが無ければループを終える
    if (!page.hasMore || !page.nextCursor) break;
    // 次ページ取得用にカーソルを前進させる
    cursor = page.nextCursor;
  }
  return { rows, truncated };
}

/**
 * CSV 全履歴エクスポートの Response を組み立てる (ファイル名への JST 日付付与・
 * Content-Disposition/Cache-Control・上限打ち切り時の X-Truncated/X-Total-Limit ヘッダー)。
 */
export function buildCsvExportResponse(params: {
  csv: string; // CSV 文字列本体 (BOM 付き)
  filenamePrefix: string; // ファイル名の接頭辞 (例: 'audit-log-full' / 'quarantine-full')
  truncated: boolean; // 上限で打ち切ったか
  maxRows: number; // 打ち切り時に X-Total-Limit へ入れる上限件数
  now?: Date; // ファイル名の日付算出に使う基準時刻 (未指定なら呼び出し時点の現在時刻)
}): Response {
  const { csv, filenamePrefix, truncated, maxRows, now = new Date() } = params;
  // ファイル名に JST の今日の日付を含める (ダウンロードフォルダで日付識別できる)
  const today = now
    .toLocaleDateString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    .replace(/\//g, '-'); // YYYY/MM/DD → YYYY-MM-DD
  const filename = `${filenamePrefix}-${today}.csv`;

  const headers: HeadersInit = {
    // UTF-8 の CSV であることを明示する
    'Content-Type': 'text/csv; charset=utf-8',
    // ブラウザにファイルとして保存させる (attachment) + ファイル名を指定する
    'Content-Disposition': `attachment; filename="${filename}"`,
    // キャッシュさせない (毎回最新データを取得させる)
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  };
  // 取得件数が上限に達した場合は打ち切りを呼び出し元に通知する
  // (サイレント打ち切りは監査目的で「全件取得済み」と誤認させるリスクがある)
  if (truncated) {
    headers['X-Truncated'] = 'true';
    headers['X-Total-Limit'] = String(maxRows);
  }
  return new Response(csv, { status: 200, headers });
}
