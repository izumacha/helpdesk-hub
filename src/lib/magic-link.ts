/**
 * Magic-link token helpers (pure crypto / URL building).
 *
 * Kept free of NextAuth, Prisma, and `next/headers` imports so it can be
 * exercised by Vitest unit tests without any test doubles.
 */
// Node 標準の暗号モジュール (乱数生成 + ハッシュ + 定数時間比較)
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// マジックリンクの既定 TTL (15 分)。秒ではなくミリ秒で持つ
export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;

// 32 byte (256 bit) のランダム値を URL 安全な base64url 文字列にして返す
// base64url なので URL に直接入れても percent-encode が要らない
export function generateMagicLinkToken(): string {
  // 32 バイトの乱数を生成
  return randomBytes(32).toString('base64url');
}

// 与えられた生トークンを SHA-256 ハッシュにし、16 進文字列で返す
// DB には常にこのハッシュを保存し、生トークンはメール内の URL でのみ運ぶ
export function hashMagicLinkToken(rawToken: string): string {
  // ハッシュ計算オブジェクトを作って 1 度だけ更新
  return createHash('sha256').update(rawToken).digest('hex');
}

// 2 つの 16 進ハッシュ文字列を定数時間で比較する (タイミング攻撃対策)
// 同じ長さ / 同じエンコードでない場合は false を返す
export function timingSafeHashEqual(a: string, b: string): boolean {
  // 長さが違うなら timingSafeEqual はエラーを投げるので、まず長さチェック
  if (a.length !== b.length) return false;
  // Buffer に変換して定数時間比較
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

// 指定した baseUrl と生トークンから、ユーザーが踏むコールバック URL を組み立てる
// 例: buildMagicLinkUrl('http://localhost:3000', 'xxx') -> 'http://localhost:3000/api/auth/magic-link/callback?token=xxx'
export function buildMagicLinkUrl(baseUrl: string, rawToken: string): string {
  // 末尾のスラッシュをトリムして二重スラッシュを防ぐ
  const trimmed = baseUrl.replace(/\/$/, '');
  // URLSearchParams で query を組み立て (token に + や = が来てもエスケープされる)
  const params = new URLSearchParams({ token: rawToken });
  return `${trimmed}/api/auth/magic-link/callback?${params.toString()}`;
}

// メール本文 (Text / HTML) を構築する純粋関数
// 件名と本文を 1 か所にまとめておくことで、テストでも国際化でも差し替えやすい
export function renderMagicLinkEmail(input: { url: string; expiresInMinutes: number }): {
  subject: string;
  text: string;
  html: string;
} {
  // 件名 (Lite モードの SMB ユーザー向けに専門用語を避ける)
  const subject = 'HelpDesk Hub ログインリンク';
  // テキスト本文 (HTML 非対応クライアント向けフォールバック)
  const text = [
    'HelpDesk Hub にログインするためのリンクをお送りします。',
    '',
    `${input.url}`,
    '',
    `このリンクの有効期限は約 ${input.expiresInMinutes} 分です。`,
    '心当たりがない場合はこのメールを破棄してください。',
  ].join('\n');
  // HTML 本文 (URL は href / 表示テキストの両方に入れる)
  const escapedUrl = escapeHtml(input.url);
  const html = `
    <p>HelpDesk Hub にログインするためのリンクをお送りします。</p>
    <p><a href="${escapedUrl}" style="display:inline-block;padding:10px 16px;background:#0f766e;color:#ffffff;border-radius:6px;text-decoration:none;font-weight:600;">ログインする</a></p>
    <p style="font-size:13px;color:#475569;">うまく開けない場合はこちらの URL をブラウザに貼り付けてください:<br><span style="word-break:break-all;">${escapedUrl}</span></p>
    <p style="font-size:13px;color:#64748b;">このリンクの有効期限は約 ${input.expiresInMinutes} 分です。<br>心当たりがない場合はこのメールを破棄してください。</p>
  `.trim();
  // 3 点セットを返す
  return { subject, text, html };
}

// HTML に挿入する文字列を最低限エスケープする (差出側自前 URL でも念のため)
function escapeHtml(s: string): string {
  // 危険な 5 文字だけを実体参照に変換
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
