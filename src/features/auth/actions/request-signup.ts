'use server';

/**
 * セルフサーブサインアップ発行サーバーアクション (公開)。
 *
 * docs/smb-dx-pivot-plan.md §7.1「30 分で運用開始」シナリオの第一歩
 * 「サインアップ（メールアドレスのみ、マジックリンク）」に対応する。`requestMagicLink`
 * (src/features/auth/actions/request-magic-link.ts) と同じ列挙耐性のマスク設計を踏襲する:
 *
 *  - 常に `{ ok: true }` を返す (メールが既存アカウントかどうかで応答を変えない)。
 *  - 既に登録済みのメールで要求された場合は、新しいテナントを作らず通常のログイン用
 *    マジックリンクを送る (`deliverMagicLinkIfUserExists` を再利用)。これにより
 *    「このメールは既に使われています」のような詮索可能なエラーを一切返さずに済む。
 *  - 未登録のメールにのみ SignupToken を発行し、サインアップ完了ページへのリンクを送る。
 *  - トークンは SHA-256 ハッシュのみ DB に保存する (生トークンはメール内 URL のみ)。
 */

// データ層の Composition Root (Prisma 直叩きを避けるための入口)
import { repos } from '@/data';
// メール内リンクのベース URL を解決する共通ヘルパー (招待リンクと共有)
import { resolveAppBaseUrl } from '@/lib/app-url';
// 環境変数で切り替わる EmailSender 実装を取得するファクトリ
import { getEmailSender, type EmailSender } from '@/lib/email';
// 既存ユーザー宛のマジックリンク発行・送信ロジック (request-magic-link.ts と共有 / §6 DRY)
import { deliverMagicLinkIfUserExists } from '@/lib/magic-link-delivery';
// 連打防止のための共通レート制限ヘルパー (create-tenant.ts 等と共有)
import { enforceRateLimit } from '@/lib/rate-limit';
// セルフサーブサインアップ用の純粋ヘルパー (トークン生成・ハッシュ・URL 構築・メール本文 + 各種定数)
import {
  buildSignupCompleteUrl,
  generateSignupToken,
  hashSignupToken,
  renderSignupEmail,
  SIGNUP_RATE_LIMIT_MAX,
  SIGNUP_RATE_LIMIT_WINDOW_MS,
  SIGNUP_REQUEST_GLOBAL_RATE_LIMIT,
  SIGNUP_TOKEN_TTL_MS,
} from '@/lib/signup';
// 列挙耐性のための最低遅延ヘルパー・遅延値 (request-magic-link.ts と共有 / §6 DRY)
import { atLeast, ENUMERATION_MASK_DELAY_MS } from '@/lib/timing';
// 入力検証スキーマ
import { requestSignupSchema } from '@/lib/validations/signup';

// requestSignup の戻り値型 (常に成功扱い)。エラーは Server Action 内で握り潰し、
// ユーザー列挙対策のため呼び出し元には漏らさない
export interface RequestSignupResult {
  ok: true;
}

// 公開する Server Action。フォームから直接呼べる形にする
export async function requestSignup(input: { email: string }): Promise<RequestSignupResult> {
  // 入力を zod で検証 + 小文字正規化
  const parsed = requestSignupSchema.safeParse(input);
  // 入力不正は日本語メッセージで例外を投げる (フォーム側でユーザーに見せる)
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? '入力が正しくありません';
    throw new Error(message);
  }
  // 検証後の正規化済みメール
  const email = parsed.data.email;

  // /code-review ultra 指摘対応 (2026-07-13): メール単位のレート制限 (下の deliverSignupOrLogin
  // 内) だけでは、攻撃者が毎回異なるメールアドレスを使うことで実質無制限に回避できる。
  // このエンドポイントは未登録の任意メールへ実際に送信 + DB 行作成を行うため、エンドポイント
  // 全体で固定キーの頭打ちを設ける (§9 公開エンドポイント保護)。上限到達時は列挙耐性の対象外
  // (どのメールであっても同じ「混み合っている」応答になるため詮索の手がかりにならない) として
  // そのまま例外を伝播させる
  enforceRateLimit('signup-request:global', SIGNUP_REQUEST_GLOBAL_RATE_LIMIT);

  // ── 列挙対策マスクの外で設定不備を先に表面化させる ──
  // request-magic-link.ts と同じ理由: 環境変数の妥当性チェックはここで throw し、
  // 運用者にそのまま 500 として見せる (ループ内の delivery 例外とは扱いを分ける)
  const baseUrl = resolveAppBaseUrl();
  const sender = getEmailSender();

  // 最低限の遅延を確保しつつ本処理を実行する。delivery 側の例外はすべて外に伝播させない
  // (既存ユーザー経路で失敗 × 新規経路で成功、という差からアカウント存在を推測されないようにする)
  await atLeast(
    (async () => {
      try {
        await deliverSignupOrLogin(email, { baseUrl, sender });
      } catch (err) {
        // 列挙対策のため例外を握り潰す。サーバーログには残す
        console.error('[signup] delivery failed (swallowed for enumeration resistance):', err);
      }
    })(),
    ENUMERATION_MASK_DELAY_MS,
  );

  // 列挙対策のため、既存/新規に関わらず常に ok を返す
  return { ok: true };
}

// メールが既に登録済みなら通常のログイン用マジックリンクを送り、未登録ならサインアップ完了
// リンクを送る内部関数。呼び出し側 (requestSignup) が列挙耐性のマスクを担当するため、
// ここでは「どちらの経路を通ったか」を一切外部に漏らさない (戻り値なし)
async function deliverSignupOrLogin(
  email: string,
  ctx: { baseUrl: string; sender: EmailSender },
): Promise<void> {
  // 既存ユーザーなら新しいテナントは作らず、通常のログイン用マジックリンクを送る。
  // これにより「登録済みメールでサインアップを試みた」ことを画面の反応から詮索されない
  // (常に「メールを確認してください」としか見えない)
  const existingUser = await repos.users.findByEmail(email);
  if (existingUser) {
    // 存在確認済みであることを渡し、deliverMagicLinkIfUserExists 内での二重検索を避ける (§6 DRY)
    await deliverMagicLinkIfUserExists(email, ctx, true);
    return;
  }

  // 期限切れトークンを一括掃除 (ベストエフォート)
  await repos.signupTokens.deleteExpired(new Date());

  // 同一メール宛の直近発行件数を取得 (発行スパム対策のレート制限)。
  // count → check → create が原子的でない点は request-magic-link.ts と同じ soft cap
  const since = new Date(Date.now() - SIGNUP_RATE_LIMIT_WINDOW_MS);
  const recent = await repos.signupTokens.countRecentByEmail(email, since);
  // 上限超過なら新規発行をスキップ (例外は投げない: 列挙対策で呼び出し側からは成功/失敗が見えない)
  if (recent >= SIGNUP_RATE_LIMIT_MAX) return;

  // 256-bit のランダムトークンを生成し、SHA-256 ハッシュを DB に記録する (Web Crypto は async)
  const rawToken = generateSignupToken();
  const tokenHash = await hashSignupToken(rawToken);
  // 失効時刻 (現在時刻 + TTL)
  const expiresAt = new Date(Date.now() + SIGNUP_TOKEN_TTL_MS);
  // DB に保存 (生トークンは保存しない)
  const created = await repos.signupTokens.create({ email, tokenHash, expiresAt });

  // 呼び出し元で解決済みの baseUrl を使ってクリック先 URL を組み立てる
  const url = buildSignupCompleteUrl(ctx.baseUrl, rawToken);
  // 件名 + 本文 (Text / HTML) を構築
  const { subject, text, html } = renderSignupEmail({
    url,
    expiresInMinutes: Math.floor(SIGNUP_TOKEN_TTL_MS / 60_000),
  });

  // 呼び出し元で取得済みの EmailSender 経由で送信。送信に失敗したら作ったトークン行を
  // 削除して rate limit の枠を消費させない (request-magic-link.ts と同じ方針)
  try {
    await ctx.sender.send({ to: email, subject, text, html });
  } catch (err) {
    // ベストエフォートで行を削除。削除自体の失敗は無視する (元エラーを優先したい)
    await repos.signupTokens.deleteById(created.id).catch(() => undefined);
    // 元の送信エラーを再 throw (呼び出し側の try-catch で握り潰される)
    throw err;
  }

  // 監査で発見したギャップ対応: 新しいトークンの送信に成功した後で、このメール宛の
  // 未消費・未失効トークン (自分自身を除く) をすべて消費済み扱いにする
  // (magic-link-delivery.ts の invalidateActiveByEmail と同じ理由・同じ配置)。
  // /code-review ultra 指摘対応: 送信前に呼んでいた当初の実装は、送信失敗時に「新しいトークンは
  // rollback で削除され、かつ古いトークンも失効済み」という二重の締め出しを起こしていた。
  await repos.signupTokens.invalidateActiveByEmail(email, new Date(), created.id);
}
