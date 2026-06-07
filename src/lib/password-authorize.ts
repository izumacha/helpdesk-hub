/**
 * Password Credentials `authorize` logic, extracted from `auth.ts` so it can be
 * unit-tested in isolation (the NextAuth() init + module-level secret fail-fast
 * in auth.ts make that module awkward to import in tests). issue #119.
 *
 * Brute-force / credential-stuffing defense:
 *  - Failed attempts are throttled per **email** (primary, not attacker-spoofable)
 *    and per **client IP** (best-effort, X-Forwarded-For is forgeable without a
 *    trusted proxy). See `login-throttle.ts`.
 *  - When a key is locked out we reject BEFORE the DB lookup + bcrypt.
 *  - On the user-not-found path we still run a dummy bcrypt compare so the
 *    response time does not reveal account existence.
 *
 * Availability tradeoff (documented, accepted): a hard email lockout means an
 * attacker who knows a victim's email can keep that account locked by sending
 * failed passwords. This is the inherent cost of failed-attempt lockout. It is
 * bounded by the 15-minute rolling window (auto-recovers) and, crucially, the
 * **magic-link login provider is intentionally NOT throttled** — a locked-out
 * user can always sign in via the emailed one-time link. Keep that recovery
 * path unthrottled.
 */
// bcryptjs のパスワード照合 (compare) と、タイミング撹乱用ダミーハッシュ生成 (hashSync)
import { compare, hashSync } from 'bcryptjs';
// next-auth の User 型 (role / tenantId は src/types/next-auth.d.ts で必須化済み)
import type { User } from 'next-auth';
// データ層の Composition Root 経由でユーザー取得 (Prisma 直叩きを避ける)
import { repos } from '@/data';
// ログイン失敗のスロットル (ブルートフォース / クレデンシャルスタッフィング対策)
import {
  clearLoginFailures,
  isLoginBlocked,
  loginEmailKey,
  loginIpKey,
  recordLoginFailure,
} from '@/lib/login-throttle';

// ユーザー不在時に compare へ渡すダミー bcrypt ハッシュ。実ユーザーと同じコスト 12 で
// 計算するため、「ユーザー有無」で bcrypt の実行有無が変わらず、応答時間の差から在不在を
// 推測されるタイミングオラクルを緩和する。遅延生成でモジュール読込コストを避ける。
let dummyPasswordHash: string | null = null;
// キャッシュ済みのダミーハッシュを返す (未計算なら 1 度だけ生成する)
function getDummyPasswordHash(): string {
  // まだ生成していなければここで bcrypt ハッシュを 1 度だけ計算する
  if (dummyPasswordHash === null) {
    dummyPasswordHash = hashSync('timing-decoy-not-a-real-password', 12);
  }
  // 生成済みのハッシュを返す
  return dummyPasswordHash;
}

// Request の転送ヘッダからクライアント IP を取り出す (best-effort)。
// 信頼できるプロキシ設定が無い環境では X-Forwarded-For は偽装可能なので、
// IP ベースのスロットルは補助。主たる防御はメール単位のロックアウト。
export function clientIpFromRequest(request: Request | undefined): string | null {
  // request が無ければ IP 不明
  if (!request) return null;
  // X-Forwarded-For (プロキシ経由の元 IP, カンマ区切りで複数) を優先的に読む
  const forwarded = request.headers.get('x-forwarded-for');
  // 値があれば先頭 (最も手前のクライアント) を採用する
  if (forwarded) {
    // カンマで分割し、先頭要素の空白を除去して返す
    const first = forwarded.split(',')[0]?.trim();
    // 空でなければそれを IP として使う
    if (first) return first;
  }
  // 予備として X-Real-IP ヘッダも見る
  const realIp = request.headers.get('x-real-ip');
  // あれば採用、無ければ null
  return realIp?.trim() || null;
}

// パスワード認証ロジック本体。成功ならユーザーオブジェクト、失敗なら null を返す。
// 第 2 引数 request からクライアント IP を取り出してスロットルに使う。
export async function passwordAuthorize(
  credentials: Partial<Record<string, unknown>> | undefined,
  request: Request | undefined,
): Promise<User | null> {
  // 入力不足ならすぐ失敗
  if (!credentials?.email || !credentials?.password) return null;

  // email を小文字化して、失敗カウントのキーを大文字小文字で割れないようにする
  const email = (credentials.email as string).trim().toLowerCase();
  // メール単位の失敗カウントキー (偽装不可の主防御)
  const emailKey = loginEmailKey(email);
  // リクエストからクライアント IP を取得 (best-effort)
  const ip = clientIpFromRequest(request);
  // IP 単位の失敗カウントキー (取得できた場合のみ)
  const ipKey = ip ? loginIpKey(ip) : null;

  // メールまたは IP が窓内の失敗上限に達していれば、bcrypt を実行せず即拒否する
  // (ブルートフォース / クレデンシャルスタッフィングのロックアウト)
  if (isLoginBlocked(emailKey) || (ipKey !== null && isLoginBlocked(ipKey))) {
    return null;
  }

  // email で User を検索 (port 経由)
  const user = await repos.users.findByEmail(email);

  // ユーザー未存在、またはパスワード未設定の場合
  if (!user || !user.passwordHash) {
    // ダミーハッシュと比較して bcrypt の処理時間を実在ユーザーと揃える
    // (在/不在を応答時間から推測されるのを防ぐ)。結果は捨てる。
    await compare(credentials.password as string, getDummyPasswordHash());
    // 失敗としてカウントする (スプレー攻撃のロックアウトに反映)
    recordLoginFailure(emailKey);
    // IP が分かっていれば IP 側にも失敗を記録する
    if (ipKey !== null) recordLoginFailure(ipKey);
    // 認証失敗
    return null;
  }

  // 入力パスワードを DB のハッシュと比較 (bcrypt)
  const isValid = await compare(credentials.password as string, user.passwordHash);
  // 一致しなければ失敗としてカウントしてから拒否する
  if (!isValid) {
    // メール単位の失敗を記録する
    recordLoginFailure(emailKey);
    // IP が分かっていれば IP 側にも記録する
    if (ipKey !== null) recordLoginFailure(ipKey);
    // 認証失敗
    return null;
  }

  // 認証成功: このメール / IP の失敗カウントをリセットする
  clearLoginFailures(emailKey);
  // IP が分かっていれば IP 側の失敗カウントもリセットする
  if (ipKey !== null) clearLoginFailures(ipKey);

  // 認証成功: セッションに乗せるユーザー情報を返す
  return {
    id: user.id, // ユーザー ID
    email: user.email, // メール
    name: user.name, // 氏名
    role: user.role, // 権限
    tenantId: user.tenantId, // 所属テナント ID (マルチテナント化のキー)
  };
}
