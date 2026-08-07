/**
 * 認証イベント監査 (AuthAuditLog) の書き込み入口。
 * 認証経路 (password-authorize / magic-link authorize / SSO ACS) はこのモジュール経由で
 * 記録し、`repos.authAudit.record` を直接呼ばない。ここに次の 3 つの防御を集約する:
 *
 * 1. **email の長さ上限**: 失敗イベントの email は未認証の攻撃者が制御できる入力。
 *    無制限長のまま INSERT すると `@@index([email, createdAt])` の B-tree 行サイズ上限を
 *    超えて INSERT 自体が失敗する (確定的な 500 を攻撃者が踏める)。RFC 5321 のメール長
 *    上限 (254) で切り詰めて記録する。
 * 2. **失敗イベントの書き込み上限 (プロセス内・固定窓)**: ログイン失敗は 1 回 = 1 監査行で、
 *    email/X-Forwarded-For を回す攻撃者は login-throttle のバケットを分散できるため、
 *    上限が無いと追記専用テーブルに行を無制限に積める (ストレージ枯渇 DoS)。窓内の失敗
 *    記録数に上限を設け、超過分は console.warn だけ残して DB 書き込みをスキップする
 *    (成功イベントは実在の資格情報・発行済みトークンが前提で流量が自然に制限されるため対象外)。
 *    対象イベントは下の `AUTH_AUDIT_EVENT_IS_FAILURE` が唯一の真実の源。
 *    予算は**イベント種別ごとに独立**させる (合計上限を種別数で等分する)。1 つの予算を全経路で
 *    共有すると、未認証で安く叩ける経路 (マジックリンクのコールバック 60 回/分・SSO ACS 20 回/分)
 *    にゴミを投げるだけで予算を先に食い潰し、本命であるパスワード総当たりの失敗記録を
 *    DB から締め出せてしまう (監査を目潰しする攻撃)。それでは「console.warn では否認防止の
 *    証跡にならない」という本モジュールの前提そのものが崩れるため、経路間の奪い合いを断つ。
 *    合計上限は分割前と同じ値のままなので、ストレージ枯渇に対する許容量は変わらない。
 * 3. **fail-open (可用性優先)**: 監査 INSERT の失敗で認証全体を落とさない。特にマジック
 *    リンク経路は「トークンを原子的に消費した後」に記録するため、ここで throw すると
 *    ワンタイムトークンが焼失したままログインが失敗し、ユーザーはリンク再発行を強いられる。
 *    失敗は文脈付きで console.error に残し (§6 エラーを握り潰さない)、認証処理は継続する。
 */

// データ層の Composition Root (Prisma 直叩きを避ける)
import { repos } from '@/data';
// 記録入力の型 (port の契約)
import type { RecordAuthAuditInput } from '@/data/ports/auth-audit-log-repository';
// イベント種別の型 (失敗イベント集合の網羅性チェックに使う)
import type { AuthAuditEvent } from '@/domain/types';

// 監査に記録する email の最大長 (RFC 5321 のメールアドレス上限に合わせる)
export const AUTH_AUDIT_EMAIL_MAX_LENGTH = 254;

// 「認証を試みて拒否された」ことは分かるが、本人のメールアドレスを特定できない経路で使う
// 代替値。マジックリンクの無効トークン (DB に行が無いので email が引けない) と SAML の
// 署名検証失敗 (検証を通っていない主張は信用できない) が該当する。
// email 列は NOT NULL なので空文字ではなく意味の分かる固定値を入れ、調査時に
// 「特定不能な試行」として一目で判別できるようにする (実在しえない形なので実メールと衝突しない)。
export const AUTH_AUDIT_UNKNOWN_EMAIL = '(unknown)';

// 失敗イベントの書き込み上限を数える固定窓の長さ (1 分)
export const AUTH_AUDIT_FAILURE_WINDOW_MS = 60_000;
// 1 窓あたりに DB へ書き込む失敗イベントの上限件数 (全種別の合計)。正規利用でこの値に達することは
// まず無い規模 (全ユーザー合計で毎分 120 失敗) に設定し、攻撃時のみ発動させる。
// 追記専用テーブルへ許容する最大流量そのものなので、この値は種別を増やしても据え置く
export const AUTH_AUDIT_FAILURE_MAX_PER_WINDOW = 120;

// 各イベントが「失敗イベント」か (= 書き込み上限 (モジュール先頭 2.) の対象か) の対応表。
// この表が唯一の真実の源で、`recordAuthAudit` はここを引いて上限の要否を決める。
//
// あえて Set ではなく Record<AuthAuditEvent, boolean> にしている: Set だと綴り間違いは
// 弾けても「新しいイベントを足したのに分類し忘れる」という最も起こりやすい失敗を検出できず、
// その経路だけ上限をすり抜けて追記専用テーブルに無制限に行を積める (ストレージ枯渇 DoS の
// 抜け穴になる)。Record なら AuthAuditEvent に値を追加した時点で「キーが足りない」と
// typecheck が落ちるため、分類の明示を機械的に強制できる。
// Readonly にしているのは、この表が DoS 対策 (書き込み上限) の判定そのものだから。
// 可変のまま export すると、他モジュールの誤った代入 1 行で上限を無効化できてしまう
export const AUTH_AUDIT_EVENT_IS_FAILURE: Readonly<Record<AuthAuditEvent, boolean>> = {
  password_login_success: false, // 実在の資格情報が前提なので流量が自然に制限される
  password_login_failure: true, // パスワード不一致 / ユーザー不在
  magic_link_login_success: false, // 発行済みトークンの消費が前提
  magic_link_login_failure: true, // 無効・失効・消費済みトークン / 孤児トークン
  sso_login_success: false, // 発行済みハンドオフトークンの消費が前提
  sso_assertion_accepted: false, // 署名検証を通ったアサーションが前提
  sso_assertion_rejected: true, // SAML の署名・条件検証に失敗
  sso_assertion_replayed: true, // 同一アサーションの再利用を検知
  sso_user_not_found: true, // 検証は通ったがテナント内にユーザーが居ない
};

// 書き込み上限の対象になる失敗イベントの一覧 (分類表から導出する)。
// 表を単一の真実の源にしておくことで、イベント追加時に一覧の更新漏れが起きない
const FAILURE_EVENTS = (Object.keys(AUTH_AUDIT_EVENT_IS_FAILURE) as AuthAuditEvent[]).filter(
  (event) => AUTH_AUDIT_EVENT_IS_FAILURE[event],
);

// イベント種別 1 つあたりの 1 窓あたり上限 = 合計上限 ÷ 失敗イベント種別数 (等分)。
// 合計上限から割り算で導くことで、種別を増やしても全種別の合計は
// AUTH_AUDIT_FAILURE_MAX_PER_WINDOW を超えない (ストレージ枯渇の許容量が勝手に増えない)。
// 同時に、各経路は他経路がいくら攻撃されても必ずこの件数だけは記録できる (目潰し防止)
export const AUTH_AUDIT_FAILURE_MAX_PER_EVENT_WINDOW = Math.floor(
  AUTH_AUDIT_FAILURE_MAX_PER_WINDOW / FAILURE_EVENTS.length,
);

// イベント種別ごとの固定窓の状態 (窓の開始時刻と、その窓で書き込んだ件数)。
// キーは enum 値だけなので Map の要素数は種別数で頭打ちになる
// (攻撃者が制御できる値をキーにするとメモリ枯渇 DoS になるため、意図的に enum 限定)
const failureWindows = new Map<AuthAuditEvent, { start: number; count: number }>();

// 失敗イベントを今 DB に書いてよいか判定し、書く場合はカウントを進める。
// 判定はイベント種別ごとに独立している (ある種別の枯渇が他種別へ波及しない)
function consumeFailureBudget(event: AuthAuditEvent, now: number): boolean {
  // この種別の現在の窓を取り出す (初回は 0 件の窓を作る)
  const window = failureWindows.get(event) ?? { start: 0, count: 0 };
  // 以降の分岐でどちらに転んでも状態を残せるよう、先に Map へ入れておく
  failureWindows.set(event, window);
  // 窓が切り替わっていたら開始時刻を更新してカウントをリセットする
  if (now - window.start >= AUTH_AUDIT_FAILURE_WINDOW_MS) {
    window.start = now;
    window.count = 0;
  }
  // この種別の上限に達していたら書き込み不可
  if (window.count >= AUTH_AUDIT_FAILURE_MAX_PER_EVENT_WINDOW) return false;
  // 1 件分の予算を消費して許可する
  window.count += 1;
  return true;
}

// 認証イベントを 1 件記録する (認証経路からの唯一の入口)。
// 例外は投げない: 監査の失敗は認証の成否に影響させない (モジュール先頭コメント参照)
export async function recordAuthAudit(input: RecordAuthAuditInput): Promise<void> {
  try {
    // 攻撃者制御の超長 email でインデックス上限を踏まないよう切り詰める
    const email = input.email.slice(0, AUTH_AUDIT_EMAIL_MAX_LENGTH);
    // 失敗イベントは書き込み上限の予算を消費できた場合のみ DB へ書く (予算は種別ごとに独立)
    if (
      AUTH_AUDIT_EVENT_IS_FAILURE[input.event] &&
      !consumeFailureBudget(input.event, Date.now())
    ) {
      // 上限超過: DoS 増幅を避けるため DB には書かず、サーバーログにだけ痕跡を残す。
      // 枯渇したのがどの種別かを書かないと「どの経路が吹いているか」が分からず調査できない。
      // イベント種別は enum 値 (外部入力でも PII でもない) なので安全に出せる。
      // email やトークンは出さない (§9 機密情報・PII をログに漏らさない)
      console.warn(
        `[auth-audit] 失敗イベントの記録が上限に達したためスキップしました (攻撃の可能性): ${input.event}`,
      );
      return;
    }
    // 監査ログへ 1 件追記する (AuthAuditLog は追記専用テーブル)
    await repos.authAudit.record({ ...input, email });
  } catch (err) {
    // fail-open: 記録失敗はログに残すだけで呼び出し元 (認証) には伝播させない
    console.error('[auth-audit] 認証イベント監査ログの記録に失敗しました:', err);
  }
}

// テスト専用: 失敗イベント書き込み上限の内部状態をリセットする (login-throttle と同じ流儀)
export function __resetAuthAuditThrottle(): void {
  // 種別ごとの窓をまとめて破棄する (次回アクセス時に 0 件の窓が作り直される)
  failureWindows.clear();
}
