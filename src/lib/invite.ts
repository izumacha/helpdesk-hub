/**
 * Invitation-link helpers (pure URL building / email rendering / constants).
 *
 * 招待リンクの「生トークン → URL」「招待メール本文」を 1 か所にまとめた純粋ヘルパー。
 * トークン生成と SHA-256 ハッシュはマジックリンクと同一方式のため `@/lib/magic-link` の
 * 関数を再利用する (DRY)。招待固有なのは URL パスとメール文面、TTL/レート制限の定数のみ。
 */

// 生トークンの生成・ハッシュ化はマジックリンクと共通 (Web Crypto 実装)
export { generateMagicLinkToken as generateInviteToken } from '@/lib/magic-link';
export { hashMagicLinkToken as hashInviteToken } from '@/lib/magic-link';
// HTML 本文に外部由来文字列を差し込む前のエスケープ (共有ヘルパーを再利用)
import { escapeHtml } from '@/lib/html-escape';

// 招待リンクの既定 TTL (7 日)。ログイン用マジックリンク (15 分) より長めにする。
// 招待は「あとで受け取って登録する」運用が前提のため、即時性は不要で猶予を持たせる。
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// 同一テナントからの発行レート制限 (招待スパム・誤連打対策)。1 時間に 30 件までを上限とする。
export const INVITE_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
// 上記の窓内で許容される発行回数の上限。
export const INVITE_RATE_LIMIT_MAX = 30;

// 指定した baseUrl と生トークンから、招待される人が踏む受諾ページの URL を組み立てる
// 例: buildInviteUrl('http://localhost:3000', 'xxx') -> 'http://localhost:3000/invite/xxx'
export function buildInviteUrl(baseUrl: string, rawToken: string): string {
  // 末尾のスラッシュをトリムして二重スラッシュを防ぐ
  const trimmed = baseUrl.replace(/\/$/, '');
  // トークンは base64url なので URL パスにそのまま入れられるが、念のため encode する
  return `${trimmed}/invite/${encodeURIComponent(rawToken)}`;
}

// 招待メール本文 (Text / HTML) を構築する純粋関数。email 指定で招待した場合のみ送信する
export function renderInviteEmail(input: {
  url: string; // 受諾ページの URL
  tenantName: string; // 参加先の組織名 (誰からの招待かを伝える)
  expiresInDays: number; // 有効期限 (日数)
}): { subject: string; text: string; html: string } {
  // 件名 (SMB ユーザー向けに専門用語を避ける)
  const subject = `${input.tenantName} への招待が届いています`;
  // テキスト本文 (HTML 非対応クライアント向けフォールバック)
  const text = [
    `${input.tenantName} のヘルプデスクに招待されました。`,
    '',
    '下のリンクを開いて、お名前とパスワードを設定すると利用を開始できます。',
    '',
    `${input.url}`,
    '',
    `このリンクの有効期限は約 ${input.expiresInDays} 日です。`,
    '心当たりがない場合はこのメールを破棄してください。',
  ].join('\n');
  // HTML 本文 (URL は href / 表示テキストの両方に入れる)
  const escapedUrl = escapeHtml(input.url);
  const escapedTenant = escapeHtml(input.tenantName);
  const html = `
    <p>${escapedTenant} のヘルプデスクに招待されました。</p>
    <p>下のボタンから、お名前とパスワードを設定すると利用を開始できます。</p>
    <p><a href="${escapedUrl}" style="display:inline-block;padding:10px 16px;background:#0f766e;color:#ffffff;border-radius:6px;text-decoration:none;font-weight:600;">参加する</a></p>
    <p style="font-size:13px;color:#475569;">うまく開けない場合はこちらの URL をブラウザに貼り付けてください:<br><span style="word-break:break-all;">${escapedUrl}</span></p>
    <p style="font-size:13px;color:#64748b;">このリンクの有効期限は約 ${input.expiresInDays} 日です。<br>心当たりがない場合はこのメールを破棄してください。</p>
  `.trim();
  // 3 点セットを返す
  return { subject, text, html };
}
