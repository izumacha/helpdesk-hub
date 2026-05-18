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
 *
 *    NOTE: this is a "minimum-floor" delay (atLeast 150ms), not a fixed
 *    end-to-end envelope. SMTP send on the known-user path can still take
 *    significantly longer than the unknown-user path, so timing-side-channel
 *    enumeration is not fully closed. Fixing requires either queueing the
 *    actual delivery (return immediately) or padding to a worst-case fixed
 *    duration. Deferred as a follow-up issue.
 *
 *  - Opportunistically deletes expired rows on each call (best-effort
 *    housekeeping; a real cron is deferred to a follow-up issue).
 *  - Configuration errors (missing `NEXTAUTH_URL` in production, broken
 *    `EMAIL_DRIVER` setup) are raised BEFORE entering the enumeration
 *    mask so operators see a hard failure instead of silent "every user
 *    sees Check your email but no email arrives" outage. Both registered
 *    and unregistered emails fail identically in this case (still no
 *    enumeration leak — the failure is configuration, not account state).
 */
// データ層の Composition Root (Prisma 直叩きを避けるための入口)
import { repos } from '@/data';
// 環境変数で切り替わる EmailSender 実装を取得するファクトリ
import { getEmailSender, type EmailSender } from '@/lib/email';
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
// DB lookup + token 生成 + email 送信の合計レイテンシを擬似的に揃える狙い。
// 注意: 上記コメントの通り「最低保証」であって「固定エンベロープ」ではない
const DUMMY_DELAY_MS = 150;

// 渡された Promise を必ず指定 ms 以上かかるように引き伸ばすヘルパー
async function atLeast<T>(promise: Promise<T>, ms: number): Promise<T> {
  // 本処理と sleep を並行に走らせて両方の完了を待つ
  const [value] = await Promise.all([promise, new Promise<void>((r) => setTimeout(r, ms))]);
  return value;
}

// マジックリンク URL を組み立てるためのベース URL を解決する。
// production で NEXTAUTH_URL が未設定だと、メールに http://localhost:3000 のリンクが
// 入ってユーザーが開けない事故になる (Codex P1 指摘)。fail-fast で運用に伝える
function resolveMagicLinkBaseUrl(): string {
  const url = process.env.NEXTAUTH_URL;
  // 明示設定があればそれを使う
  if (url) return url;
  // 本番で未設定はリンクが壊れるので即エラー
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'NEXTAUTH_URL is required in production to issue working magic-link URLs',
    );
  }
  // dev/test では localhost で十分
  return 'http://localhost:3000';
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

  // ── 列挙対策マスクの外で設定不備を先に表面化させる ──
  // getEmailSender() / resolveMagicLinkBaseUrl() は環境変数の妥当性チェックを兼ねるため、
  // ここで投げた例外は呼び出し側 (= 操作した運用者) にそのまま 500 として返したい。
  // ループ内の delivery 例外 (DB / SMTP 一時障害) とは扱いを分ける (Codex P1 指摘)。
  // 未登録メールでも同じく throw されるので列挙耐性は壊れない
  const baseUrl = resolveMagicLinkBaseUrl();
  const sender = getEmailSender();

  // 最低限の遅延を確保しつつ本処理を実行する。
  // ここから先の delivery 側の例外 (DB / SMTP 一時障害 / runtime) は外に伝播させない:
  // 既知ユーザーで失敗 × 未知ユーザーで成功 という差からアカウント存在を推測されない
  // ようにするため、どんな失敗でも常に { ok: true } を返す。ログには残して運用側で気付けるようにする
  await atLeast(
    (async () => {
      try {
        await deliverMagicLinkIfUserExists(email, { baseUrl, sender });
      } catch (err) {
        // 列挙対策のため例外を握り潰す。サーバーログには残す
        console.error('[magic-link] delivery failed (swallowed for enumeration resistance):', err);
      }
    })(),
    DUMMY_DELAY_MS,
  );

  // 列挙対策のため、ユーザー有無に関わらず常に ok を返す
  return { ok: true };
}

// 実際にトークン発行 + メール送信を行う内部関数。User が見つからない or レート上限超過なら何もしない
async function deliverMagicLinkIfUserExists(
  email: string,
  ctx: { baseUrl: string; sender: EmailSender },
): Promise<void> {
  // 期限切れトークンを一括掃除 (ベストエフォート。User の有無に関係なく行う)
  await repos.magicLinks.deleteExpired(new Date());

  // 同一メール宛の直近発行件数を取得 (発行スパム対策のレート制限)。
  // 注意: count → check → create が原子的でないため、同一メールへの並行リクエストが
  // 完全に同じタイミングで来た場合、両方が recent < MAX を観測して上限を 1-2 件超過
  // し得る (soft cap)。SMB Lite スケールでは同一ユーザーから ms 単位の並行要求は
  // 想定外なので許容。厳密化が必要になったら pg_advisory_xact_lock などで原子化する
  // (フォローアップ課題)
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
  const created = await repos.magicLinks.create({ email, tokenHash, expiresAt });

  // 呼び出し元で解決済みの baseUrl を使ってクリック先 URL を組み立てる
  const url = buildMagicLinkUrl(ctx.baseUrl, rawToken);
  // 件名 + 本文 (Text / HTML) を構築
  const { subject, text, html } = renderMagicLinkEmail({
    url,
    expiresInMinutes: Math.floor(MAGIC_LINK_TTL_MS / 60_000),
  });

  // 呼び出し元で取得済みの EmailSender 経由で送信。送信に失敗したら作ったトークン行を
  // 削除して rate limit の枠を消費させない (SMTP 不調で連打した結果、ユーザーが
  // メール 1 通も受け取れないまま上限に達する事故を防ぐ)
  try {
    await ctx.sender.send({ to: email, subject, text, html });
  } catch (err) {
    // ベストエフォートで行を削除。削除自体の失敗は無視する (元エラーを優先したい)
    await repos.magicLinks.deleteById(created.id).catch(() => undefined);
    // 元の送信エラーを再 throw (外側 requestMagicLink の try-catch で握り潰される)
    throw err;
  }
}
