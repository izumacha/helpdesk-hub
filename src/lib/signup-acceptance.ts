/**
 * サインアップトークンの受諾可否を読み取り専用で判定するヘルパー (サーバー専用・Server Action ではない)。
 *
 * /code-review ultra 指摘対応 (2026-07-19): isSignupAcceptable は元々 `'use server'`
 * モジュール (features/auth/actions/complete-signup.ts) から export されていたが、Next.js は
 * `'use server'` ファイルの export をすべて「公開 Server Action エンドポイント」として登録する。
 * 本関数の利用元は Server Component (app/signup/complete/page.tsx) のみで、エンドポイント化する
 * 必要が一切ないのに、レート制限のない匿名呼び出し可能なトークン有効性オラクル (DB 参照付き)
 * を公開してしまっていた。invite-acceptance.ts と同じ方針で Server Action ではない本モジュールへ
 * 移設し、公開面から除外する。
 *
 * 注: repos (Prisma) に依存するため、クライアント安全な純粋ヘルパー集 (@/lib/signup) には
 * 置かず専用モジュールとする。
 */

// データ層の Composition Root (Prisma 直叩きを避けるための入口)
import { repos } from '@/data';
// サインアップトークンのハッシュ化 (生トークン → DB 保存値と同じ SHA-256 へ)
import { hashSignupToken } from '@/lib/signup';

// サインアップ完了ページが「このトークンが今この瞬間に有効か」を表示判定するための読み取り専用
// ヘルパー。消費はしない (ページ表示で焼かないため)。期限切れ / 使用済み / 不在なら false を返す。
export async function isSignupAcceptable(rawToken: string): Promise<boolean> {
  // 生トークンを DB 保存値と同じ SHA-256 ハッシュへ変換する
  const tokenHash = await hashSignupToken(rawToken);
  // tokenHash でサインアップトークンを引く (読み取りのみ)
  const signup = await repos.signupTokens.findByTokenHash(tokenHash);
  // 不在 / 使用済み / 失効はいずれも受諾不可
  return !!signup && signup.consumedAt === null && signup.expiresAt >= new Date();
}
