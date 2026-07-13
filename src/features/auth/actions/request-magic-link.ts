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
// メール内リンクのベース URL を解決する共通ヘルパー (招待リンクと共有)
import { resolveAppBaseUrl } from '@/lib/app-url';
// 環境変数で切り替わる EmailSender 実装を取得するファクトリ
import { getEmailSender } from '@/lib/email';
// 既存ユーザー宛のマジックリンク発行・送信ロジック (§7.1 セルフサーブサインアップと共有 / §6 DRY)
import { deliverMagicLinkIfUserExists } from '@/lib/magic-link-delivery';
// 列挙耐性のための最低遅延ヘルパー (セルフサーブサインアップと共有 / §6 DRY)
import { atLeast } from '@/lib/timing';
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

// 公開する Server Action。フォームから直接呼べる形にする (FormData 経由でも JSON でも可)
export async function requestMagicLink(input: { email: string }): Promise<RequestMagicLinkResult> {
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
  // getEmailSender() / resolveAppBaseUrl() は環境変数の妥当性チェックを兼ねるため、
  // ここで投げた例外は呼び出し側 (= 操作した運用者) にそのまま 500 として返したい。
  // ループ内の delivery 例外 (DB / SMTP 一時障害) とは扱いを分ける (Codex P1 指摘)。
  // 未登録メールでも同じく throw されるので列挙耐性は壊れない
  const baseUrl = resolveAppBaseUrl();
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
