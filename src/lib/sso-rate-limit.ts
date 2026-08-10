// SSO (SAML) エンドポイント群 (acs/login/metadata) が共有するレート制限の定数。
// /code-review ultra 指摘対応: 「固定キーの全体制限 (60秒60回) → tenantId 確定後の
// テナント単位制限 (60秒20回)」という同一の制限値・エラーメッセージが acs/route.ts・
// login/route.ts・metadata/route.ts の 3 箇所に複製されていたため (CLAUDE.md §6
// 「2〜3 箇所目で共通化する」を超過)、ここに集約する。
//
// tenantId は DB 検証前 (URL セグメント) の値で攻撃者が自由に変更できるため、これ単体を
// キーにすると値を変えるだけで無制限に回避されてしまう。そのためテナント解決 (DB 参照) より
// 前に固定キーで全体の上限を設け、テナントの実在・SSO 有効性を確認できた後にさらに
// tenantId (DB 由来で信頼できる値) をキーにしたテナント単位の制限を重ねる二段構えにする。

// 固定キーの全体レート制限 (テナント解決前に適用)
export const SSO_UNAUTHENTICATED_RATE_LIMIT = { limit: 60, windowMs: 60_000 } as const;

// テナント単位のレート制限 (テナントの実在・SSO 有効性を確認できた後に適用)
export const SSO_TENANT_RATE_LIMIT = { limit: 20, windowMs: 60_000 } as const;

// レート制限超過時にクライアントへ返す共通の日本語メッセージ
export const SSO_RATE_LIMIT_MESSAGE = 'しばらく時間をおいて再度お試しください';

// ACS (POST /api/auth/sso/<tenantId>/acs) が受け付けるリクエストボディの最大バイト数 (1MB)。
// SAML アサーションは署名・証明書込みでも通常数十 KB で、属性が多いディレクトリでも
// base64 + URL エンコード後に 1MB へ届くことはまず無い。一方 ACS は未認証で到達でき、
// フォームのパースはボディ全体をメモリに載せるため、上限が無いと巨大ボディの送り付けで
// メモリを枯渇させられる (§9)。実際の読み取りは request-body-limit.ts が担う。
// ここ (レート制限と同じファイル) に置くのは、いずれも「未認証リクエストの受け入れ枠」を
// 決める値で、route とテストの両方から同じ定義を参照させたいため
export const SSO_ACS_MAX_BODY_BYTES = 1024 * 1024;
