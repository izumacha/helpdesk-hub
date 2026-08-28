// LINE 取り込みエンドポイント (inbound/line) が使うレート制限の定数。
// /code-review ultra 指摘対応: 回帰テストが上限値 (120) をループ回数として直書きしていたため、
// **上限を引き上げると検出網が黙って死ぬ**状態になっていた (上限 200 に変えたうえで
// 脆弱性を再導入しても 35 件すべて緑のまま通ることを実測で確認)。ボディサイズ上限
// (`webhook-body-limits.ts` の `LINE_WEBHOOK_MAX_BODY_BYTES`) と同じく、ルートとテストが
// 同じ定義を参照して「片方だけ値を変えたら気付ける」形にするためここへ集約する
// (CLAUDE.md §6 マジックナンバーを避ける / 単一の参照元に置く)。
//
// 置き場所を `sso-rate-limit.ts` に倣って `src/lib/` にしているのは、テスト側が
// 静的 import で参照できるようにするため。ルート本体 (`route.ts`) から export すると、
// テストが `@/data` のモックを設定する前にルートモジュールを評価してしまい、
// 既存の `vi.resetModules()` ＋ 動的 import の順序を崩す。
//
// 二段構えの意図: `destination` は署名検証前の値で攻撃者が自由に生成できるため、これを
// キーにすると値を毎回変えるだけで無制限に新しいバケットが作られ、事実上回避されてしまう。
// そのため DB 参照 (findByBotUserId) の前段では固定キーで「未認証リクエスト全体」の上限を
// 設け、`destination` をどれだけ変えても DB 参照の総量が頭打ちになるようにする。

// 固定キーの全体レート制限 (テナント解決より前に適用)
export const LINE_UNAUTHENTICATED_RATE_LIMIT = { limit: 600, windowMs: 60_000 } as const;

// チャネル (テナント) 単位の取り込み流量上限 (シークレット漏洩時のスパムを抑える)。
// **署名検証を通過した後にのみ適用する。** 前に置くと、署名を持たない第三者でもこの枠を
// 消費でき、正規の Webhook を 429 で締め出せてしまう (取り込み停止攻撃)。
// `lineConfig.tenantId` は DB 由来の信頼できる値 (botUserId の @unique 制約でテナントと 1:1)。
export const LINE_RATE_LIMIT = { limit: 120, windowMs: 60_000 } as const;

// レート制限超過時にクライアントへ返す共通の日本語メッセージ
export const LINE_RATE_LIMIT_MESSAGE = '取り込みが混み合っています';
