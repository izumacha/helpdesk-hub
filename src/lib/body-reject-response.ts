// ボディを読めなかったときの HTTP 応答 (ログ 1 行 ＋ JSON レスポンス) を組み立てるヘルパー。
//
// **なぜ `request-body-limit.ts` と別ファイルなのか**: あちらは「受信ストリームを上限つきで
// 読む」だけのフレームワーク非依存なユーティリティで、同種の処理 (`webhook-fetch.ts` の
// `readBodyCapped` / `line-content.ts` の `readBodyCappedBytes`) との統合が将来の検討対象に
// なっている。そこへ `next/server` の import を持ち込むと、バイト列を読みたいだけの
// 呼び出し元 (テストや非ルートの利用者) まで Next に引きずられ、統合時には HTTP 応答の
// 関心事を剥がし直す作業が増える。ステータスコードとユーザー向け文言の決定は
// ルート層の関心事なので、こちら側に分ける。

import { NextResponse } from 'next/server';
// 拒否理由の型・ステータスの振り分け・ログの出し方は読み取り側 (request-body-limit.ts) が持つ
import { bodyRejectStatus, logBodyReject, type BodyRejectReason } from '@/lib/request-body-limit';

// 拒否時に返す文言の一覧。**理由ごとに 1 つずつ決める**のが要点 (下の bodyRejectResponse を参照)。
// 型引数でその経路に起こりうる理由だけに絞れるようにしてある — 例えば本文を読むだけの経路
// (readTextWithinByteLimit のみ) は 'unparsable' が構造上起こらないので、
// `BodyRejectMessages<BodyReadRejectReason>` にすれば到達しない文言を書かずに済む
export type BodyRejectMessages<R extends BodyRejectReason = BodyRejectReason> = Readonly<
  Record<R, string>
>;

/**
 * ボディを読めなかったときの「サーバーログ 1 行 ＋ クライアントへの JSON レスポンス」をまとめて作る。
 *
 * 本モジュールを採用するルートは例外なく「理由をログに出す → ステータスを引く → 文言を選ぶ →
 * NextResponse.json で返す」の 4 手を踏むため、3 経路目になった時点でここへ集約した (§6 DRY)。
 *
 * **文言は `status` ではなく `reason` で引く。** `status === 413 ? A : B` と書くと、拒否理由が
 * ステータスの 2 値へ潰れてしまい、将来 `timeout → 408` のような 3 つ目のステータスを
 * `bodyRejectStatus` に足したとき、408 に噛み合わない文言が黙って組み合わさる。
 *
 * ここで機械的に保証できるのは「**理由を増やしたら文言の決め忘れで typecheck が落ちる**」
 * ところまで (`Record<BodyRejectReason, string>` を必須にしているため)。既存の理由に別の
 * ステータスを割り当て直したときに文言まで見直させる仕組みは無いので、`bodyRejectStatus` を
 * 変更するときは各ルートの文言表も一緒に見ること。
 *
 * @param reason 読み取りが失敗した理由
 * @param maxBytes 適用していた上限バイト数 (ログの文言に載せる)
 * @param options ログの接頭辞・理由ごとの文言・(あれば) 原因の例外
 */
export function bodyRejectResponse<R extends BodyRejectReason>(
  reason: R,
  maxBytes: number,
  options: {
    logPrefix: string; // ログ行の先頭に付ける識別子。角括弧まで含めて渡す (例: '[POST /api/inbound/line]')
    messages: BodyRejectMessages<R>; // その経路に起こりうる理由ごとの日本語の文言
    cause?: unknown; // 原因の例外 (readFormWithinByteLimit の unparsable でのみ渡る)
  },
): NextResponse {
  // 拒否理由と (あれば) 原因の例外をサーバーログへ 1 行で残す (出し方は 5 経路で共通)
  logBodyReject(options.logPrefix, reason, maxBytes, options.cause);
  // 理由に対応する文言とステータスで JSON を返す (外部には理由の詳細を出さない)
  return NextResponse.json(
    { error: options.messages[reason] },
    { status: bodyRejectStatus(reason) },
  );
}
