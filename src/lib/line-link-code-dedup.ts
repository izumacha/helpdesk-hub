// LINE Webhook の連携コード処理 (紐付け成功/競合) 専用の冪等化ヘルパー。
// src/app/api/inbound/line/route.ts から使う。
//
// なぜ別ファイルに分離しているか: Next.js の Route Handler (route.ts) は
// GET/POST/config/runtime 等の決められた export しか許可しない (それ以外の named
// export があると `next build` の型検査が "not a valid Route export field" で失敗する)。
// テスト専用のリセット/検査用ヘルパーを route.ts に直接 export できないため、
// この状態と関数群を独立した lib モジュールに切り出し、route.ts からは通常の
// import として使う。
//
// 背景: 連携コード送信での紐付け成立は起票を伴わないため、lineMessages 対応表
// (createTicketIdempotent が使う DB 冪等化) の対象外になる。連携成功直後に Webhook
// 応答が遅延して LINE が同一メッセージを再送すると、2 回目はコードが既に消費済みで
// invalid になり、コード文字列そのものが本文の問い合わせとして誤起票され得た。
// このメモリ上の Map で「直近に連携コードとして処理済みの messageId」を記憶し、再送時は
// 連携ロジックへ進まず即座にスキップする。sse-subscribers.ts / rate-limit.ts と同じ
// 「インプロセス Map」の制約 (水平スケール未対応・複数インスタンス間で共有されない) を受け入れる。
// キーは messageId のみで tenantId を含まない: LINE のメッセージ ID はプラットフォーム全体で
// 一意な値であり (lineMessages 対応表の DB 冪等化と異なりテナント間でキーが衝突しないため)、
// §9 のクロステナント漏洩対策としての tenantId スコープは元々不要 (メッセージの中身は一切
// 保持しないため漏洩し得る情報も無い)。

// 連携コード処理 (紐付け成功/競合) の冪等化用 TTL。LINE の再送窓 (5 分) に余裕を持たせる
const LINK_CODE_DEDUP_TTL_MS = 10 * 60 * 1000;
// 直近「連携コードとして処理済み」の LINE メッセージ ID を憶えておく、インプロセスの Map
const recentlyLinkedMessageIds = new Map<string, number>(); // messageId -> 処理時刻 (ms)

// messageId が直近 (TTL 以内) に連携コードとして処理済みかを判定する。期限切れエントリは掃除する
export function wasRecentlyProcessedAsLinkCode(messageId: string): boolean {
  // 記録が無ければ未処理
  const processedAt = recentlyLinkedMessageIds.get(messageId);
  if (processedAt === undefined) return false;
  // TTL を過ぎていれば期限切れとして削除し、未処理扱いにする (Map の無限増加を防ぐ)
  if (Date.now() - processedAt > LINK_CODE_DEDUP_TTL_MS) {
    recentlyLinkedMessageIds.delete(messageId);
    return false;
  }
  // TTL 内なので処理済み
  return true;
}

// messageId を「連携コードとして処理済み」として記録する
export function markProcessedAsLinkCode(messageId: string): void {
  // 現在時刻を記録する (TTL 判定の基準)
  recentlyLinkedMessageIds.set(messageId, Date.now());
  // このキー以外のエントリも含めて、既に TTL を過ぎたものを掃除する (rate-limit.ts の
  // sweepStaleBuckets と同じ「ながら掃除」)。wasRecentlyProcessedAsLinkCode は「同じ
  // messageId が再度問い合わせられたとき」しか掃除しないため、二度と再送されない
  // (= 大多数の) messageId はここで掃除しない限り Map に残り続けてしまう
  sweepStaleLinkCodeEntries(Date.now());
}

// recentlyLinkedMessageIds 全体を走査し、TTL を過ぎたエントリを削除する
function sweepStaleLinkCodeEntries(now: number): void {
  // Map の全エントリを走査する
  for (const [messageId, processedAt] of recentlyLinkedMessageIds) {
    // TTL を過ぎていれば削除する
    if (now - processedAt > LINK_CODE_DEDUP_TTL_MS) {
      recentlyLinkedMessageIds.delete(messageId);
    }
  }
}

// テスト専用: recentlyLinkedMessageIds をクリアする (src/lib/rate-limit.ts の
// __resetRateLimits と同じ理由。route モジュールはテスト間で import キャッシュが
// 共有されるため、固定の messageId ('m1' 等) を使う別テストの記録が漏れ込むのを防ぐ)
export function __resetLineLinkCodeDedup(): void {
  // Map を空にする (次のテストへ記録を持ち越さない)
  recentlyLinkedMessageIds.clear();
}

// テスト専用: recentlyLinkedMessageIds の現在のエントリ数を返す (無制限増加しないことの検証用)
export function __getLineLinkCodeDedupSize(): number {
  return recentlyLinkedMessageIds.size;
}
