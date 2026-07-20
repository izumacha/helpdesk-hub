/**
 * Self-serve signup helpers (pure URL building / email rendering / constants).
 *
 * docs/smb-dx-pivot-plan.md §7.1「30 分で運用開始」シナリオの第一歩
 * (「サインアップ（メールアドレスのみ、マジックリンク）」) に対応する。
 * トークン生成と SHA-256 ハッシュはマジックリンク・招待と同一方式のため `@/lib/magic-link` の
 * 関数を再利用する (DRY)。サインアップ固有なのは URL パスとメール文面、TTL/レート制限の定数のみ。
 */

// 生トークンの生成・ハッシュ化はマジックリンクと共通 (Web Crypto 実装)
export { generateMagicLinkToken as generateSignupToken } from '@/lib/magic-link';
export { hashMagicLinkToken as hashSignupToken } from '@/lib/magic-link';
// HTML 本文に外部由来文字列を差し込む前のエスケープ (共有ヘルパーを再利用)
import { escapeHtml } from '@/lib/html-escape';

// サインアップ完了リンクの既定 TTL (15 分)。ログイン用マジックリンクと同じ (即時性が前提の操作のため)
export const SIGNUP_TOKEN_TTL_MS = 15 * 60 * 1000;

// 同一メール宛の発行レート制限 (発行スパム対策)。15 分間に 5 通までを上限とする。
// マジックリンクと同じ値を採用し、公開エンドポイントとしての防御水準を揃える
export const SIGNUP_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const SIGNUP_RATE_LIMIT_MAX = 5;

// /code-review ultra 指摘対応 (2026-07-13): 上記のメール単位レート制限は、攻撃者が毎回
// 別のメールアドレス (plus-addressing や使い捨てドメイン等) を使えば実質無制限に回避できる。
// requestMagicLink と違いこのエンドポイントは「未登録の任意メールに実際にメール送信 + DB 行
// 作成を行う」ため、既存ユーザー宛にしか送らないログイン用マジックリンクよりも踏み台にされる
// リスクが高い。既存の enforceRateLimit (src/lib/rate-limit.ts) を固定キーで使い、
// テナント/ユーザー単位ではなくエンドポイント全体で発行数を頭打ちにする (§9 公開エンドポイント保護)
export const SIGNUP_REQUEST_GLOBAL_RATE_LIMIT = { limit: 20, windowMs: 60_000 } as const;

// 監査で発見したギャップ対応 (2026-07-20): 上記は「発行 (requestSignup)」側のみを守っており、
// 「完了 (completeSignup)」側には全体レート制限が一切なかった。completeSignup は公開
// (未認証) アクションかつ Serializable トランザクションでテナント + 初代管理者を作成する
// 重い処理のため、accept-invitation.ts の INVITE_ACCEPT_GLOBAL_RATE_LIMIT と同じ設計
// (固定キーでエンドポイント全体を頭打ちにする) を適用する。値も同じ 1 分 30 件に揃える
// (テナント作成という同種の重さの操作であり、防御水準を割る理由がないため)
export const SIGNUP_COMPLETE_GLOBAL_RATE_LIMIT = { limit: 30, windowMs: 60_000 } as const;

// 指定した baseUrl と生トークンから、サインアップ完了ページの URL を組み立てる
// 例: buildSignupCompleteUrl('http://localhost:3000', 'xxx') -> 'http://localhost:3000/signup/complete?token=xxx'
export function buildSignupCompleteUrl(baseUrl: string, rawToken: string): string {
  // 末尾のスラッシュをトリムして二重スラッシュを防ぐ
  const trimmed = baseUrl.replace(/\/$/, '');
  // URLSearchParams で query を組み立て (token に + や = が来てもエスケープされる)
  const params = new URLSearchParams({ token: rawToken });
  return `${trimmed}/signup/complete?${params.toString()}`;
}

// サインアップ完了メール本文 (Text / HTML) を構築する純粋関数
export function renderSignupEmail(input: { url: string; expiresInMinutes: number }): {
  subject: string;
  text: string;
  html: string;
} {
  // 件名 (SMB ユーザー向けに専門用語を避ける)
  const subject = 'HelpDesk Hub のサインアップを完了する';
  // テキスト本文 (HTML 非対応クライアント向けフォールバック)
  const text = [
    'HelpDesk Hub へのサインアップ、ありがとうございます。',
    '',
    '下のリンクを開いて、組織名・業種を設定すると利用を開始できます。',
    '',
    `${input.url}`,
    '',
    `このリンクの有効期限は約 ${input.expiresInMinutes} 分です。`,
    '心当たりがない場合はこのメールを破棄してください。',
  ].join('\n');
  // HTML 本文 (URL は href / 表示テキストの両方に入れる)
  const escapedUrl = escapeHtml(input.url);
  const html = `
    <p>HelpDesk Hub へのサインアップ、ありがとうございます。</p>
    <p>下のボタンから、組織名・業種を設定すると利用を開始できます。</p>
    <p><a href="${escapedUrl}" style="display:inline-block;padding:10px 16px;background:#0f766e;color:#ffffff;border-radius:6px;text-decoration:none;font-weight:600;">サインアップを完了する</a></p>
    <p style="font-size:13px;color:#475569;">うまく開けない場合はこちらの URL をブラウザに貼り付けてください:<br><span style="word-break:break-all;">${escapedUrl}</span></p>
    <p style="font-size:13px;color:#64748b;">このリンクの有効期限は約 ${input.expiresInMinutes} 分です。<br>心当たりがない場合はこのメールを破棄してください。</p>
  `.trim();
  // 3 点セットを返す
  return { subject, text, html };
}
