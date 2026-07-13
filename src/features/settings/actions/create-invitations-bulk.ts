'use server';

/**
 * 招待リンクを複数メールアドレス (CSV アップロード or 貼り付け) からまとめて発行するサーバー
 * アクション (管理者専用)。
 *
 * docs/smb-dx-pivot-plan.md §7.1 フォローアップ (2026-07-10): 「30 分で運用開始」シナリオの
 * 手順3は「メンバーを招待（リンク貼り付け or CSV）」と明記していたが、実装は 1 件ずつしか
 * 発行できず、「CSV」経路が存在しなかった不備を解消する。
 *
 * セキュリティ要点は createInvitation (単発発行) と同一:
 *  - tenantId / invitedById はセッション由来のみを使う (クロステナント招待の防止)。
 *  - 発行は admin のみ (assertAdminSession)。
 *  - テナント単位の発行レート制限 (バッチ全体で 1 回、上限超過分もまとめて拒否する)。
 */

// データ層の Composition Root (Prisma 直叩きを避けるための入口)
import { repos } from '@/data';
// 現在のセッション (ログイン中ユーザー) を取得
import { auth } from '@/lib/auth';
// メール内リンクのベース URL を解決する共通ヘルパー
import { resolveAppBaseUrl } from '@/lib/app-url';
// 管理者権限を強制する共通アサーション
import { assertAdminSession } from '@/lib/role';
// 招待発行の共有ロジック (createInvitation と同じヘルパーを再利用する)
import { issueInvitation } from './create-invitation';
// 招待固有の定数 (レート制限) と、複数行テキストからメールアドレス候補を抽出する純粋関数
import {
  INVITE_RATE_LIMIT_MAX,
  INVITE_RATE_LIMIT_WINDOW_MS,
  extractEmailCandidates,
} from '@/lib/invite';
// 一括招待フォームの入力検証スキーマ (権限 / メールアドレス一覧)
import { bulkInviteEmailsSchema, invitableRoleSchema } from '@/lib/validations/invite';
// CSV 入力の上限バイト数 (ticket import と共有。過大な貼り付け/アップロードを弾く)
import { MAX_CSV_BYTES } from '@/lib/csv';
// Phase 4 課金: プランごとのスタッフシート空き状況チェック (createInvitation と共有)
import { checkSeatAvailability } from '@/lib/tenant-plan';
// Prisma の一意制約違反 (P2002) 判定の共通ヘルパー (6 箇所に重複していた判定を一元化 / §6 DRY)
import { isUniqueConstraintError } from '@/lib/prisma-errors';
// フォローアップ (2026-07-11): 設定変更監査ログへの記録共通ヘルパー (§4.2/§4.3 と同じ方式)
import { recordSettingsAudit } from '@/lib/settings-audit';

// 一括発行 1 行分の結果 (成功した URL、または失敗理由)
export interface BulkInvitationRowResult {
  email: string; // 対象のメールアドレス
  ok: boolean; // 発行に成功したか
  url?: string; // 成功時: 発行された招待リンク
  error?: string; // 失敗時: ユーザー向け日本語エラーメッセージ
}

// createInvitationsBulk の戻り値型
export interface CreateInvitationsBulkResult {
  results: BulkInvitationRowResult[]; // 入力順の行ごとの結果一覧
}

// 招待リンクを複数メールアドレスからまとめて発行するサーバーアクション。フォーム (FormData) から呼ぶ。
// FormData には role (単一) と emails (改行/CSV 区切りの複数行テキスト) を積む。
export async function createInvitationsBulk(
  formData: FormData,
): Promise<CreateInvitationsBulkResult> {
  // セッション取得
  const session = await auth();
  // 管理者権限を要求 (失敗時は日本語エラーを throw)
  assertAdminSession(session);
  // 参加先テナントはログイン中テナントのみ (クロステナント招待の防止)
  const tenantId = session.user.tenantId;

  // 権限 (バッチ全体で単一のロールを共有する。行ごとに変えたいケースは複数回に分けて実行する)
  const roleParsed = invitableRoleSchema.safeParse(formData.get('role'));
  if (!roleParsed.success) {
    throw new Error(roleParsed.error.issues[0]?.message ?? '権限の指定が正しくありません');
  }
  const role = roleParsed.data;

  // メールアドレス一覧の生テキストを取り出す (textarea 直接入力、または File.text() 読み込み結果)
  const rawEmails = String(formData.get('emails') ?? '');
  // 過大な入力はサイズ上限で弾く (ticket import と同じ上限を流用して一貫させる)
  if (new TextEncoder().encode(rawEmails).length > MAX_CSV_BYTES) {
    throw new Error('入力内容が大きすぎます');
  }

  // 複数行テキスト (1 行 1 メール、または CSV) からメールアドレス候補を抽出する
  const candidates = extractEmailCandidates(rawEmails);
  // 形式検証 + 件数上限チェック (1 件も無い / 上限超過はここでまとめて弾く)
  const emailsParsed = bulkInviteEmailsSchema.safeParse(candidates);
  if (!emailsParsed.success) {
    throw new Error(
      emailsParsed.error.issues[0]?.message ?? 'メールアドレスの指定が正しくありません',
    );
  }
  const emails = emailsParsed.data;

  // 期限切れ招待をベストエフォートで掃除 (createInvitation と同じ)
  await repos.invitations.deleteExpired(new Date());

  // テナント単位の発行レート制限をバッチ全体で 1 回だけ確認する。
  // このバッチを発行すると上限を超える場合は、1 件も発行せずにまとめて拒否する
  // (一部だけ発行されて admin が「どこまで届いたか」を判別しづらくなる事態を避ける)。
  const since = new Date(Date.now() - INVITE_RATE_LIMIT_WINDOW_MS);
  const recent = await repos.invitations.countRecentByTenant(tenantId, since);
  if (recent + emails.length > INVITE_RATE_LIMIT_MAX) {
    throw new Error(
      `一度に発行できる招待は最大 ${INVITE_RATE_LIMIT_MAX} 件までです (直近1時間で既に ${recent} 件発行済み)。しばらく待ってから再度お試しください。`,
    );
  }

  // 受諾ページ URL のベースをバッチ開始前に 1 回だけ解決する (createInvitation と同じ fail-fast 方針)
  const baseUrl = resolveAppBaseUrl();

  // /code-review ultra 指摘対応 (2026-07-10): このバッチが agent 権限の招待を要求している場合、
  // シート枠の空きをバッチ開始前に 1 回だけ見積もる。
  // issueInvitation 内の checkSeatAvailability は「現在の実ユーザー数」だけを見ており、招待の
  // 発行自体はユーザー数を増やさないため、ループ内で毎回呼んでも判定値は変わらない
  // (= バッチ内の 2 件目以降も「空きあり」と判定され続け、残り枠を超えて発行できてしまっていた)。
  // レート制限と同じ「バッチ全体で 1 回だけ確認し、超過するなら 1 件も発行せず拒否する」方針に揃える。
  if (role === 'agent') {
    const seat = await checkSeatAvailability(repos, tenantId);
    if (emails.length > seat.remaining) {
      throw new Error(
        `このプランのメンバー上限 (${seat.limit} 名) に対し、残り ${seat.remaining} 枠しかありません (${emails.length} 件を招待しようとしました)。プランをアップグレードするか、件数を減らしてください。`,
      );
    }
  }

  // 全行を並行して発行する (行ごとに独立した処理であり、DB 書き込み + メール送信を待つため
  // 直列に await すると件数分だけ応答が遅くなる。シート枠は上でバッチ全体分を検証済みのため、
  // issueInvitation 側の再チェックは skipSeatCheck でスキップし、行数分の無駄な SELECT も避ける)。
  // /code-review ultra 指摘対応 (2026-07-10): 直列 for ループだと 30 件で応答が数秒〜十数秒に
  // なりうるため、update-ticket.ts の Promise.all によるメール/LINE 並行送信と同じ方針に揃えた。
  const results: BulkInvitationRowResult[] = await Promise.all(
    emails.map(async (email): Promise<BulkInvitationRowResult> => {
      try {
        const { url } = await issueInvitation({
          tenantId,
          invitedById: session.user.id,
          role,
          email,
          baseUrl,
          skipSeatCheck: true,
        });
        return { email, ok: true, url };
      } catch (err) {
        // 1 行の失敗 (トークン重複などの想定外エラー) で他の行の発行を止めない (部分成功を許容する)。
        // /code-review ultra 指摘対応 (2026-07-13): err.message をそのままクライアントへ返すと
        // 想定外エラー時に Prisma の内部エラー文言 (接続情報等) が漏れうる (§9 セキュリティ)。
        // create-location.ts 等の他アクションと同じく、既知の一意制約違反だけ安全な日本語
        // メッセージへ変換し、それ以外は生の err.message を返さず汎用メッセージへ丸める。
        // Prisma の一意制約違反 (P2002、招待トークン衝突など) を共通ヘルパーで検出する
        const uniqueConstraint = isUniqueConstraintError(err);
        // 想定外エラーはサーバー側ログにだけ詳細を残す (クライアントには漏らさない)
        if (!uniqueConstraint) {
          console.error('[create-invitations-bulk] 招待発行エラー:', email, err);
        }
        return {
          email,
          ok: false,
          error: uniqueConstraint
            ? 'この招待の発行に失敗しました (重複)'
            : '招待の発行に失敗しました',
        };
      }
    }),
  );

  // フォローアップ (2026-07-11): 招待リンク発行 (agent 権限付与になりうる) を監査ログへ記録する。
  // importTickets が 200 件のインポートでも通知を 1 通にまとめるのと同じ方針で、1 行ごとではなく
  // バッチ全体で 1 回だけ記録する (30 件の一括招待で監査ログが 30 行増えるのを避ける)。
  // 1 件も成功しなかった (全行エラー) 場合は「実際には何も付与していない」ため記録しない。
  const successCount = results.filter((r) => r.ok).length;
  if (successCount > 0) {
    await recordSettingsAudit({
      tenantId,
      actorId: session.user.id,
      action: 'invitation_issue',
      logPrefix: '[create-invitations-bulk]',
    });
  }

  // 行ごとの結果一覧を返す (画面で成功/失敗を一覧表示する。Promise.all は入力順を保つため
  // 行の順序は入力どおりに保たれる)
  return { results };
}
