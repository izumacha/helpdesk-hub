/**
 * マジックリンク Credentials プロバイダの `authorize` ロジック。
 * `auth.ts` から分離して単体テスト可能にする (auth.ts はモジュール読込時に NextAuth() 初期化と
 * シークレットの fail-fast が走るためテストから import しづらい。password-authorize.ts を
 * issue #119 で分離したのと同じ理由・同じ流儀)。
 *
 * /api/auth/magic-link/callback ルートが署名済みトークンを携えて signIn('magic-link', ...) を
 * 呼び、SSO (SAML) の ACS もセッション引き渡しに同じ経路を再利用する (purpose='ssoHandoff')。
 */

// next-auth の User 型 (role / tenantId は src/types/next-auth.d.ts で必須化済み)
import type { User } from 'next-auth';
// データ層の Composition Root 経由でトークン消費・ユーザー取得 (Prisma 直叩きを避ける)
import { repos } from '@/data';
// マジックリンクのトークンハッシュ計算 (生トークン -> DB 検索キー)
import { hashMagicLinkToken } from '@/lib/magic-link';
// 認証イベント監査の書き込み入口 (否認防止。fail-open で認証を止めない)。
// AUTH_AUDIT_UNKNOWN_EMAIL は本人のメールを特定できない失敗経路で使う代替値
import { recordAuthAudit, AUTH_AUDIT_UNKNOWN_EMAIL } from '@/lib/auth-audit';

// マジックリンク認証ロジック本体。成功ならユーザーオブジェクト、失敗なら null を返す。
// トークン検証: 「未消費 + 失効前 + 存在」を 1 度の DB 更新で確定させて消費する
export async function magicLinkAuthorize(
  credentials: Partial<Record<string, unknown>> | undefined,
): Promise<User | null> {
  // トークンが渡されていなければ失敗
  if (!credentials?.token) return null;
  // 受け取った生トークンを SHA-256 でハッシュして DB 検索キーに変換 (Web Crypto は async)
  const tokenHash = await hashMagicLinkToken(credentials.token as string);
  // 原子的に消費 (未消費 & 失効前なら自身が成功し他は null)。検索 + 検証 + 消費を 1 操作で行う
  const consumed = await repos.magicLinks.consumeValidToken({ tokenHash, now: new Date() });
  // 消費に失敗 (消費済み / 失効済み / 不在) ならログイン拒否
  if (!consumed) {
    // 認証イベント監査 (否認防止): 無効トークンでのログイン試行を記録する。
    // 消費できなかった時点で DB に該当行が無く、対象メールを一切特定できないため
    // email は AUTH_AUDIT_UNKNOWN_EMAIL で残す (トークン自体は秘密情報なので記録しない)。
    // 個々の試行は誰宛か分からなくても、「無効トークンの試行がいつ何件あったか」は
    // リンク総当たりの兆候として調査価値がある (件数は auth-audit の失敗上限で有界)
    await recordAuthAudit({
      event: 'magic_link_login_failure',
      email: AUTH_AUDIT_UNKNOWN_EMAIL,
      userId: null,
      tenantId: null,
    });
    // ログイン拒否
    return null;
  }

  // トークン作成時に保存されていた email から既存ユーザーを引く
  const user = await repos.users.findByEmail(consumed.email);
  // ユーザーが消えていれば失敗 (孤児トークン)
  if (!user) {
    // 認証イベント監査 (否認防止): 発行後にユーザーが削除された孤児トークンでの試行を記録する。
    // ここでは対象メールがトークン行から分かるので実メールを残す (userId/tenantId は不明で null)。
    // SSO 引き渡し (purpose='ssoHandoff') も同じ失敗イベントで残す: 分かるのは「トークン行の
    // 用途」だけで、失敗の原因 (ユーザー消失) は経路によらず同一のため、種別を分けても
    // 調査情報が増えない (成功時は経路ごとにイベントを分ける — そちらは意味が異なるため)
    await recordAuthAudit({
      event: 'magic_link_login_failure',
      email: consumed.email,
      userId: null,
      tenantId: null,
    });
    // ログイン拒否
    return null;
  }

  // 認証イベント監査 (否認防止): このトークン消費によるログイン成功を記録する。
  // SSO (SAML) の ACS はセッション引き渡しに同じマジックリンク経路を再利用する
  // (purpose='ssoHandoff') ため、purpose で経路を区別して別イベントとして残す。
  // recordAuthAudit は fail-open: トークンは直前に消費済みなので、監査失敗で throw すると
  // ワンタイムトークンが焼失したままログインが失敗してしまう (auth-audit.ts 参照)
  await recordAuthAudit({
    event: consumed.purpose === 'ssoHandoff' ? 'sso_login_success' : 'magic_link_login_success',
    email: user.email,
    userId: user.id,
    tenantId: user.tenantId,
  });

  // セッションに乗せるユーザー情報を返す (パスワード経路と同じ shape)
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    tenantId: user.tenantId,
  };
}
