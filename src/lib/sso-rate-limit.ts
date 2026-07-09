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
