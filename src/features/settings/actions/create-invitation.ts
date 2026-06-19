'use server';

/**
 * 招待リンク発行サーバーアクション (管理者専用)。
 *
 * admin が自テナントへのメンバー招待リンクを 1 件発行する。生トークンは戻り値の URL で
 * のみ返し、DB には SHA-256 ハッシュだけを保存する (マジックリンクと同方式)。
 * email を指定した場合は案内メールも送るが、失敗してもリンク自体は返す (admin が手渡しできる)。
 *
 * セキュリティ要点:
 *  - tenantId / invitedById はセッション由来のみを使い、リクエスト入力から注入させない
 *    (クロステナント招待の防止 / docs/smb-dx-pivot-plan.md §5.6)。
 *  - 発行は admin のみ (assertAdminSession)。
 *  - テナント単位の発行レート制限で招待スパム・誤連打を抑止する。
 */

// データ層の Composition Root (Prisma 直叩きを避けるための入口)
import { repos } from '@/data';
// 現在のセッション (ログイン中ユーザー) を取得
import { auth } from '@/lib/auth';
// メール内リンクのベース URL を解決する共通ヘルパー
import { resolveAppBaseUrl } from '@/lib/app-url';
// 環境変数で切り替わる EmailSender 実装を取得するファクトリ
import { getEmailSender } from '@/lib/email';
// 招待固有のトークン生成・ハッシュ・URL/メール構築・各種定数
import {
  buildInviteUrl,
  generateInviteToken,
  hashInviteToken,
  INVITE_RATE_LIMIT_MAX,
  INVITE_RATE_LIMIT_WINDOW_MS,
  INVITE_TTL_MS,
  renderInviteEmail,
} from '@/lib/invite';
// 管理者権限を強制する共通アサーション
import { assertAdminSession } from '@/lib/role';
// 招待発行フォームの入力検証スキーマ
import { createInvitationSchema } from '@/lib/validations/invite';

// createInvitation の戻り値型 (発行した招待リンクの URL を返す)
export interface CreateInvitationResult {
  url: string; // 受諾ページの URL (admin がコピーして共有する / メールにも入る)
}

// 招待リンクを 1 件発行するサーバーアクション。フォーム (FormData) から呼ぶ
export async function createInvitation(formData: FormData): Promise<CreateInvitationResult> {
  // セッション取得
  const session = await auth();
  // 管理者権限を要求 (失敗時は日本語エラーを throw)
  assertAdminSession(session);
  // 参加先テナントはログイン中テナントのみ (クロステナント招待の防止)
  const tenantId = session.user.tenantId;

  // フォーム入力 (role / email) を Zod で検証する
  const parsed = createInvitationSchema.safeParse({
    role: formData.get('role'),
    email: formData.get('email'),
  });
  // 検証失敗ならユーザー向け日本語メッセージで throw
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? '入力が正しくありません');
  }
  // 検証済みの権限と宛先メール (未指定なら undefined)
  const { role, email } = parsed.data;

  // 期限切れ招待をベストエフォートで掃除 (専用 cron はフォローアップ課題)
  await repos.invitations.deleteExpired(new Date());

  // テナント単位の発行レート制限 (招待スパム・誤連打を抑止)。
  // マジックリンク同様 DB カウントで判定し、再起動をまたいでも効くようにする。
  const since = new Date(Date.now() - INVITE_RATE_LIMIT_WINDOW_MS);
  const recent = await repos.invitations.countRecentByTenant(tenantId, since);
  // 上限超過なら admin にエラーを見せて中断する (マジックリンクと違い列挙耐性は不要)
  if (recent >= INVITE_RATE_LIMIT_MAX) {
    throw new Error('招待の発行が多すぎます。しばらく待ってから再度お試しください。');
  }

  // 256-bit のランダムトークンを生成し、SHA-256 ハッシュを DB に保存する (生は URL のみ)
  const rawToken = generateInviteToken();
  const tokenHash = await hashInviteToken(rawToken);
  // 失効時刻 (現在時刻 + TTL)
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  // DB に招待行を作成 (tenantId / invitedById はセッション由来のみ)
  const created = await repos.invitations.create({
    tokenHash,
    tenantId,
    role,
    expiresAt,
    email: email ?? null,
    invitedById: session.user.id,
  });

  // 受諾ページの URL を組み立てる (NEXTAUTH_URL ベース)
  const url = buildInviteUrl(resolveAppBaseUrl(), rawToken);

  // email を指定した場合のみ案内メールを送る。送信失敗してもリンクは返す (admin が手渡し可能)
  if (email) {
    try {
      // 参加先の組織名を取得して件名/本文に使う
      const tenant = await repos.tenants.findById(tenantId);
      // 件名 + 本文 (Text / HTML) を構築
      const { subject, text, html } = renderInviteEmail({
        url,
        tenantName: tenant?.name ?? 'HelpDesk Hub',
        expiresInDays: Math.floor(INVITE_TTL_MS / (24 * 60 * 60 * 1000)),
      });
      // EmailSender 経由で送信
      await getEmailSender().send({ to: email, subject, text, html });
    } catch (err) {
      // 送信失敗はログに残すが、招待自体は有効なので URL は返す。
      // 行を消すとリンクが無効になるため、ここでは created を削除しない
      console.error('[invite] email delivery failed (link still issued):', created.id, err);
    }
  }

  // 発行した招待リンクの URL を返す (画面でコピー表示する)
  return { url };
}
