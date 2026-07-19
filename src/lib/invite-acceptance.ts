/**
 * 招待トークンの受諾可否を読み取り専用で判定するヘルパー (サーバー専用・Server Action ではない)。
 *
 * /code-review ultra 指摘対応 (2026-07-19): isInvitationAcceptable は元々 `'use server'`
 * モジュール (features/auth/actions/accept-invitation.ts) から export されていたが、Next.js は
 * `'use server'` ファイルの export をすべて「公開 Server Action エンドポイント」として登録する。
 * 本関数の利用元は Server Component (app/invite/[token]/page.tsx) のみで、エンドポイント化する
 * 必要が一切ないのに、レート制限のない匿名呼び出し可能なトークン有効性オラクル (DB 参照付き)
 * を公開してしまっていた。invite-issue.ts と同じ方針で Server Action ではない本モジュールへ
 * 移設し、公開面から除外する。
 */

// データ層の Composition Root (Prisma 直叩きを避けるための入口)
import { repos } from '@/data';
// 招待トークンのハッシュ化 (生トークン → DB 保存値と同じ SHA-256 へ)
import { hashInviteToken } from '@/lib/invite';

// 受諾ページが「このトークンが今この瞬間に有効か」を表示判定するための読み取り専用ヘルパー。
// 消費はしない (ページ表示で焼かないため)。期限切れ / 使用済み / 不在なら false を返す。
export async function isInvitationAcceptable(
  rawToken: string,
): Promise<{ acceptable: boolean; needsEmail: boolean }> {
  // 生トークンを DB 保存値と同じ SHA-256 ハッシュへ変換する
  const tokenHash = await hashInviteToken(rawToken);
  // tokenHash で招待を引く (読み取りのみ)
  const invitation = await repos.invitations.findByTokenHash(tokenHash);
  // 不在 / 使用済み / 失効はいずれも受諾不可
  if (!invitation || invitation.consumedAt !== null || invitation.expiresAt < new Date()) {
    return { acceptable: false, needsEmail: false };
  }
  // 招待にメールが無い場合は、受諾フォームでメール入力を求める必要がある
  return { acceptable: true, needsEmail: invitation.email === null };
}
