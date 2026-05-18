'use server';

/**
 * Magic-link request server action.
 *
 * Issues a one-time login token for the given email and sends it via the
 * configured `EmailSender`. Designed to be safe to call from the public
 * `/login` page:
 *
 *  - Always returns `{ ok: true }` regardless of whether a user exists
 *    (no user enumeration via the public endpoint).
 *  - Stores only the SHA-256 hash of the token; the raw token lives only
 *    in the emailed URL.
 *  - Adds a small constant delay on the "no user" path so request latency
 *    does not reveal account existence.
 *  - Opportunistically deletes expired rows on each call (best-effort
 *    housekeeping; a real cron is deferred to a follow-up issue).
 */
// データ層の Composition Root (Prisma 直叩きを避けるための入口)
import { repos } from '@/data';
// 環境変数で切り替わる EmailSender 実装を取得するファクトリ
import { getEmailSender } from '@/lib/email';
// マジックリンク用の純粋ヘルパー (トークン生成・ハッシュ・URL 構築・メール本文 + 各種定数)
import {
  buildMagicLinkUrl,
  generateMagicLinkToken,
  hashMagicLinkToken,
  MAGIC_LINK_RATE_LIMIT_MAX,
  MAGIC_LINK_RATE_LIMIT_WINDOW_MS,
  MAGIC_LINK_TTL_MS,
  renderMagicLinkEmail,
} from '@/lib/magic-link';
// 入力検証スキーマ
import { requestMagicLinkSchema } from '@/lib/validations/auth';

// requestMagicLink の戻り値型 (常に成功扱い)。エラーは Server Action 内で握り潰し、
// ユーザー列挙対策のため呼び出し元には漏らさない
export interface RequestMagicLinkResult {
  ok: true;
}

// 「ユーザーが見つからない」経路で挿入するダミー遅延 (ms)。
// DB lookup + token 生成 + email 送信の合計レイテンシを擬似的に揃える狙い
const DUMMY_DELAY_MS = 150;

// 渡された Promise を必ず指定 ms 以上かかるように引き伸ばすヘルパー
async function atLeast<T>(promise: Promise<T>, ms: number): Promise<T> {
  // 本処理と sleep を並行に走らせて両方の完了を待つ
  const [value] = await Promise.all([promise, new Promise<void>((r) => setTimeout(r, ms))]);
  return value;
}

// 公開する Server Action。フォームから直接呼べる形にする (FormData 経由でも JSON でも可)
export async function requestMagicLink(
  input: { email: string },
): Promise<RequestMagicLinkResult> {
  // 入力を zod で検証 + 小文字正規化
  const parsed = requestMagicLinkSchema.safeParse(input);
  // 入力不正は日本語メッセージで例外を投げる (フォーム側でユーザーに見せる)
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? '入力が正しくありません';
    throw new Error(message);
  }
  // 検証後の正規化済みメール
  const email = parsed.data.email;

  // 最低限の遅延を確保しつつ本処理を実行する
  await atLeast(deliverMagicLinkIfUserExists(email), DUMMY_DELAY_MS);

  // 列挙対策のため、ユーザー有無に関わらず常に ok を返す
  return { ok: true };
}

// 実際にトークン発行 + メール送信を行う内部関数。User が見つからない or レート上限超過なら何もしない
async function deliverMagicLinkIfUserExists(email: string): Promise<void> {
  // 期限切れトークンを一括掃除 (ベストエフォート。User の有無に関係なく行う)
  await repos.magicLinks.deleteExpired(new Date());

  // 同一メール宛の直近発行件数を取得 (発行スパム対策のレート制限)
  const since = new Date(Date.now() - MAGIC_LINK_RATE_LIMIT_WINDOW_MS);
  const recent = await repos.magicLinks.countRecentByEmail(email, since);
  // 上限超過なら新規発行をスキップ (例外は投げない: 列挙対策で呼び出し側からは成功/失敗が見えない)
  if (recent >= MAGIC_LINK_RATE_LIMIT_MAX) return;

  // メールから既存ユーザーを引く (テナント横断 lookup)
  const user = await repos.users.findByEmail(email);
  // 未登録のメールに対しては何も発行しない (列挙されない)
  if (!user) return;

  // 256-bit のランダムトークンを生成し、SHA-256 ハッシュを DB に記録する (Web Crypto は async)
  const rawToken = generateMagicLinkToken();
  const tokenHash = await hashMagicLinkToken(rawToken);
  // 失効時刻 (現在時刻 + TTL)
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS);
  // DB に保存 (生トークンは保存しない)
  await repos.magicLinks.create({ email, tokenHash, expiresAt });

  // クリック先 URL を組み立てる。NEXTAUTH_URL を基準にすればローカル/本番で自動切替
  const baseUrl = process.env.NEXTAUTH_URL ?? 'http://localhost:3000';
  const url = buildMagicLinkUrl(baseUrl, rawToken);
  // 件名 + 本文 (Text / HTML) を構築
  const { subject, text, html } = renderMagicLinkEmail({
    url,
    expiresInMinutes: Math.floor(MAGIC_LINK_TTL_MS / 60_000),
  });

  // 環境変数で選んだ EmailSender 経由で送信
  const sender = getEmailSender();
  await sender.send({ to: email, subject, text, html });
}
