/**
 * 招待リンク発行の共有ロジック (サーバー専用・Server Action ではない)。
 *
 * /security-review 指摘対応 (2026-07-19): このヘルパーは元々 `'use server'` モジュール
 * (features/settings/actions/create-invitation.ts) から export されていたが、Next.js は
 * `'use server'` ファイルの export をすべて「公開 Server Action エンドポイント」として登録する。
 * issueInvitation は tenantId / invitedById / role を引数から受け取る設計 (認証・レート制限・
 * 監査ログは呼び出し側の責務) のため、エンドポイント化すると認証なしでクロステナントの
 * agent 招待を発行できてしまう。認証ゲート付きの呼び出し元 (createInvitation /
 * createInvitationsBulk) だけが import できるよう、Server Action ではない本モジュールへ移設した。
 *
 * セキュリティ契約 (呼び出し側の責務):
 *  - assertAdminSession 等で認証・権限を確認してから呼ぶこと。
 *  - tenantId / invitedById にはセッション由来の値のみを渡すこと (リクエスト入力を渡さない)。
 *  - レート制限・期限切れ掃除・監査ログ記録は呼び出し側で行うこと。
 */

// データ層の Composition Root (Prisma 直叩きを避けるための入口)
import { repos } from '@/data';
// 環境変数で切り替わる EmailSender 実装を取得するファクトリ
import { getEmailSender } from '@/lib/email';
// 招待固有のトークン生成・ハッシュ・URL/メール構築・TTL 定数
import {
  buildInviteUrl,
  generateInviteToken,
  hashInviteToken,
  INVITE_TTL_MS,
  renderInviteEmail,
} from '@/lib/invite';
// Phase 4 課金: プランごとのスタッフシート空き状況チェック (accept-invitation.ts と共有)
import { checkSeatAvailability } from '@/lib/tenant-plan';
// 権限型 (issueInvitation の引数に使う)
import type { Role } from '@/domain/types';

// 招待リンク発行の戻り値型 (発行した招待リンクの URL を返す)
export interface CreateInvitationResult {
  url: string; // 受諾ページの URL (admin がコピーして共有する / メールにも入る)
}

// 招待リンクを 1 件発行する内部ヘルパー。
// §7.1 フォローアップ (2026-07-10): 一括招待 (create-invitations-bulk.ts) も同じ
// 「シート上限確認 → トークン発行 → DB 保存 → (メール指定時) 案内メール送信」を必要とするため、
// createInvitation から切り出して両者で共有する (§6 DRY: 2 箇所目の複製が生じる前に共通化)。
// レート制限チェック・期限切れ招待の掃除・baseUrl 解決はバッチ全体で 1 回で済む処理のため、
// 呼び出し側 (1 件発行 / 一括発行) の責務のまま残す。
export async function issueInvitation(input: {
  tenantId: string; // 参加先テナント (呼び出し側がセッション由来の値のみを渡すこと)
  invitedById: string; // 招待を発行した管理者の ID
  role: Role; // 付与する権限 (requester | agent)
  email?: string; // 案内メール宛先 (未指定なら発行のみ)
  baseUrl: string; // 受諾ページ URL のベース (呼び出し側で resolveAppBaseUrl() 済みの値)
  // /code-review ultra 指摘対応 (2026-07-10): 一括招待 (create-invitations-bulk.ts) は
  // バッチ全体で 1 回だけシート枠を見積もってから呼び出すため、ここでの再チェックは
  // 常に同じ currentUserCount (招待発行だけではユーザー数は増えない) を読み直すだけの
  // 無駄な SELECT になる。true のときはこの関数内のシートチェックをスキップする
  skipSeatCheck?: boolean;
}): Promise<CreateInvitationResult> {
  const { tenantId, invitedById, role, email, baseUrl, skipSeatCheck } = input;

  // Phase 4 課金: このロールがシートを消費する場合のみ上限を確認する (requester はシート対象外)
  if (role === 'agent' && !skipSeatCheck) {
    // テナントのプランを取得してスタッフシートの空き状況を確認する (受諾時と共通のロジック)
    const seat = await checkSeatAvailability(repos, tenantId);
    // 上限に達している場合は招待発行そのものを拒否する
    if (!seat.available) {
      throw new Error(
        `このプランのメンバー上限 (${seat.limit} 名) に達しています。プランをアップグレードしてください。`,
      );
    }
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
    invitedById,
  });

  // 受諾ページの URL を組み立てる (呼び出し側で解決済みの baseUrl を使う)
  const url = buildInviteUrl(baseUrl, rawToken);

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
