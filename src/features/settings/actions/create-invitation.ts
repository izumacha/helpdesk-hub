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
 *  - フォローアップ (2026-07-11): agent 権限の招待は新しい人物に全チケットへのアクセスを
 *    付与しうるため、発行成功時に SettingsAuditLog (invitation_issue) へ記録する。
 */

// データ層の Composition Root (Prisma 直叩きを避けるための入口)
import { repos } from '@/data';
// 現在のセッション (ログイン中ユーザー) を取得
import { auth } from '@/lib/auth';
// メール内リンクのベース URL を解決する共通ヘルパー
import { resolveAppBaseUrl } from '@/lib/app-url';
// 招待固有の定数 (レート制限)
import { INVITE_RATE_LIMIT_MAX, INVITE_RATE_LIMIT_WINDOW_MS } from '@/lib/invite';
// 招待発行の共有ロジック (認証・レート制限は本アクション側の責務)。
// /security-review 指摘対応 (2026-07-19): issueInvitation は元々このファイルから export して
// いたが、`'use server'` モジュールの export はすべて公開 Server Action エンドポイントとして
// 登録されるため、認証チェックを持たない同関数が直接呼び出し可能になっていた。
// Server Action ではない @/lib/invite-issue へ移設し、認証ゲート付きの本アクションと
// createInvitationsBulk だけが import して使う構成に変更した。
import { issueInvitation, type CreateInvitationResult } from '@/lib/invite-issue';
// 管理者権限を強制する共通アサーション
import { assertAdminSession } from '@/lib/role';
// 招待発行フォームの入力検証スキーマ
import { createInvitationSchema } from '@/lib/validations/invite';
// フォローアップ (2026-07-11): 設定変更監査ログへの記録共通ヘルパー (§4.2/§4.3 と同じ方式)
import { recordSettingsAudit } from '@/lib/settings-audit';

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
    // 任意フィールドは未送信時 null・空白のみの入力も「未指定」扱いにしたいので trim して渡す
    // (スキーマは '' を未指定として undefined に正規化する)
    email: (formData.get('email') ?? '').toString().trim(),
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

  // 受諾ページ URL のベースを「行を作る前」に解決して fail-fast する。
  // production で NEXTAUTH_URL 未設定だと resolveAppBaseUrl が throw するが、行作成後に
  // 呼ぶと招待行だけが孤児として DB に残り URL も admin に渡らない。先に解決して防ぐ。
  const baseUrl = resolveAppBaseUrl();

  // 共有ヘルパーで実際の発行処理を行う
  const result = await issueInvitation({
    tenantId,
    invitedById: session.user.id,
    role,
    email,
    baseUrl,
  });

  // フォローアップ (2026-07-11): 招待リンク発行 (agent 権限付与になりうる) を監査ログへ記録する。
  // §4.2/§4.3 と同じ「操作が成功した後に呼び、記録失敗は本来の操作の成否に影響させない」方針
  await recordSettingsAudit({
    tenantId,
    actorId: session.user.id,
    action: 'invitation_issue',
    logPrefix: '[create-invitation]',
  });

  return result;
}
