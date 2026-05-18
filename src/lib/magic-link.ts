/**
 * Magic-link token helpers (pure crypto / URL building).
 *
 * Implemented with the Web Crypto API (`globalThis.crypto`) rather than
 * Node's `node:crypto` module so this file can be statically imported from
 * `src/lib/auth.ts` (which the Edge middleware bundles). Node 18+ exposes
 * the same Web Crypto interface globally, so behaviour is identical on the
 * server.
 */

// マジックリンクの既定 TTL (15 分)。秒ではなくミリ秒で持つ
export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;

// 同一メール宛の発行レート制限 (発行スパム対策)。15 分間に 5 通までを上限とする
export const MAGIC_LINK_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
// 上記の窓内で許容される発行回数の上限。これを超えた場合は新規発行をスキップする
export const MAGIC_LINK_RATE_LIMIT_MAX = 5;

// 32 byte (256 bit) のランダム値を URL 安全な base64url 文字列にして返す
// base64url なので URL に直接入れても percent-encode が要らない
export function generateMagicLinkToken(): string {
  // 32 バイトのバッファを用意し Web Crypto に乱数を埋めてもらう
  const buf = new Uint8Array(32);
  globalThis.crypto.getRandomValues(buf);
  // バイト列を base64url 文字列に変換して返す
  return bytesToBase64Url(buf);
}

// 与えられた生トークンを SHA-256 ハッシュにし、16 進文字列で返す (非同期)
// DB には常にこのハッシュを保存し、生トークンはメール内の URL でのみ運ぶ
export async function hashMagicLinkToken(rawToken: string): Promise<string> {
  // 入力文字列を UTF-8 バイト列に変換 (Web Crypto は ArrayBuffer/TypedArray を要求する)
  const data = new TextEncoder().encode(rawToken);
  // SHA-256 で要約
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  // ArrayBuffer → 16 進文字列
  return bufferToHex(digest);
}

// 2 つの 16 進ハッシュ文字列を定数時間で比較する (タイミング攻撃対策)
// 同じ長さでない場合は false を返す
export function timingSafeHashEqual(a: string, b: string): boolean {
  // 長さが違うなら早期 false (情報量は char 数のみ)
  if (a.length !== b.length) return false;
  // XOR の累積で 1 文字でも違いがあれば 0 以外になる
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    // 文字コードを XOR してビット OR で累積 (短絡しないので定数時間)
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  // 1 度も差が無ければ 0 = true
  return result === 0;
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

// バイト列を base64url (RFC 4648 §5) 文字列に変換する内部ヘルパー
function bytesToBase64Url(buf: Uint8Array): string {
  // バイトを 1 文字ずつ "Latin-1" の文字列に積む (btoa は Latin-1 のみ受け付ける)
  let bin = '';
  for (let i = 0; i < buf.length; i++) {
    bin += String.fromCharCode(buf[i]);
  }
  // 標準 base64 にしたあと、URL 安全文字に置換 + パディングを除去
  return globalThis.btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ArrayBuffer を小文字 16 進文字列に変換する内部ヘルパー
function bufferToHex(buf: ArrayBuffer): string {
  // 1 バイトずつ 2 桁 16 進に整形して結合
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
