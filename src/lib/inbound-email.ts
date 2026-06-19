/**
 * Inbound email helpers (pure parsing / routing — no I/O).
 *
 * docs/smb-dx-pivot-plan.md Phase 2「メール取り込み」(§4 / §5.3) の中核となる純粋ヘルパー。
 * SendGrid Inbound Parse / Postmark Inbound / Amazon SES などのプロバイダが Webhook で
 * POST してくる「受信メール 1 通分」のフィールド群を、アプリ内部で扱いやすい正規化済みの形
 * (宛先トークン / 送信者アドレス / 件名 / 本文) に変換する。プロバイダ依存のフィールド名差は
 * 呼び出し側 (Route Handler) が吸収し、ここでは「文字列が来たらどう解釈するか」だけを担う。
 *
 * すべて副作用のない純粋関数なので、DB を持ち込まずユニットテスト (tests/inbound-email.test.ts)
 * で網羅できる。外部入力をそのまま扱うため、長さ上限 (DoS 防止) とアドレス抽出を必ずここで行う。
 */

// 件名の最大保存長 (文字数)。RFC 5322 の 998 octets より少し余裕を見つつ、UI 表示も考慮して制限する
export const INBOUND_SUBJECT_MAX = 500;
// 本文の最大保存長 (文字数)。巨大メールでの DB / メモリ枯渇を防ぐためのハードキャップ (§8 / §9)
export const INBOUND_BODY_MAX = 100_000;
// メールアドレスの最大長 (文字数)。RFC 上の上限 (254) を基準にし、異常に長い入力を弾く
export const INBOUND_ADDRESS_MAX = 254;
// 件名が空のときに使う既定タイトル (Lite 用語に合わせ専門用語を避ける)
export const INBOUND_DEFAULT_SUBJECT = '(件名なし)';
// 自動生成する取り込みトークンの長さ (英小文字 + 数字)。十分長く取り衝突を実質ゼロにする
const INBOUND_TOKEN_LENGTH = 16;
// 取り込みトークンに使う文字集合。メールのローカルパートに安全な英小文字 + 数字のみに限定する
const INBOUND_TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

// 正規化済みの受信メール 1 通分。Route Handler はこれを使ってチケットを作る
export interface ParsedInboundEmail {
  recipientToken: string; // 宛先アドレスのローカルパート (テナント特定キー)
  senderAddress: string; // 送信者メールアドレス (小文字正規化済み)
  senderName: string; // 送信者の表示名 (取れなければアドレスを流用)
  subject: string; // 件名 (空なら既定タイトル / 上限まで切り詰め済み)
  body: string; // 本文テキスト (上限まで切り詰め済み)
}

// "表示名 <addr@example.com>" や "addr@example.com" から純粋なメールアドレスを取り出す。
// 取り出せない / 妥当でない場合は null を返す (呼び出し側で fail-closed に倒す)。
export function extractEmailAddress(raw: string | null | undefined): string | null {
  // null / undefined / 空文字はアドレス無しとして扱う
  if (!raw) return null;
  // 前後の空白を除去する (ヘッダ値には余分な空白が付きやすい)
  const trimmed = raw.trim();
  // 異常に長い入力はここで弾く (アドレス抽出前にコストを抑える)
  if (trimmed.length === 0 || trimmed.length > INBOUND_ADDRESS_MAX * 2) return null;
  // "<addr>" 形式なら山括弧の中身を優先して取り出す
  const angle = trimmed.match(/<([^>]+)>/);
  // 山括弧があればその中身、無ければ全体をアドレス候補とする
  const candidate = (angle ? angle[1] : trimmed).trim().toLowerCase();
  // 簡易なアドレス妥当性チェック (ローカルパート@ドメイン、空白なし、長さ上限内)。
  // 外部入力に対し ReDoS を避けるためネストした量指定子を使わない単純パターンにする
  if (candidate.length > INBOUND_ADDRESS_MAX) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate)) return null;
  // 妥当なアドレスを返す
  return candidate;
}

// メールアドレスから "@" より前のローカルパートだけを取り出す。
// アドレスとして妥当でない場合は null を返す。
export function localPartOf(address: string | null | undefined): string | null {
  // まずアドレスとして正規化する (表示名付きでも受け付ける)
  const normalized = extractEmailAddress(address);
  // 正規化できなければローカルパートも取れない
  if (!normalized) return null;
  // "@" の位置を探す
  const at = normalized.indexOf('@');
  // "@" が無い / 先頭にある場合はローカルパート無しとして扱う
  if (at <= 0) return null;
  // "@" より前を返す
  return normalized.slice(0, at);
}

// 受信メールの宛先からテナント特定用のトークン (ローカルパート) を取り出す。
// expectedDomain を渡した場合は、宛先ドメインが一致するときだけトークンを返す (誤ルーティング防止)。
export function extractInboundToken(
  toRaw: string | null | undefined,
  expectedDomain?: string | null,
): string | null {
  // 宛先アドレスを正規化する
  const address = extractEmailAddress(toRaw);
  // アドレスが取れなければトークンも無い
  if (!address) return null;
  // 期待ドメインが指定されている場合はドメイン一致を必須にする
  if (expectedDomain && expectedDomain.trim().length > 0) {
    // 宛先のドメイン部 ("@" より後ろ) を取り出して小文字化
    const domain = address.slice(address.indexOf('@') + 1);
    // 期待ドメインと一致しなければ取り込み対象外 (null)
    if (domain !== expectedDomain.trim().toLowerCase()) return null;
  }
  // ローカルパートをトークンとして返す
  return localPartOf(address);
}

// 取り込みトークンと配信ドメインから、テナントに案内する転送先アドレスを組み立てる。
// 例: buildInboundAddress('abc123', 'inbox.helpdesk-hub.app') -> 'abc123@inbox.helpdesk-hub.app'
export function buildInboundAddress(token: string, domain: string): string {
  // トークン@ドメイン の単純連結 (token は英数字に限定済みなのでエスケープ不要)
  return `${token}@${domain}`;
}

// テナント作成時に払い出す取り込みトークンを生成する (英小文字 + 数字 16 文字)。
// Web Crypto の乱数を使い予測困難にする (推測で他テナントの取り込み口を当てられないように)。
export function generateInboundToken(): string {
  // 必要文字数分の乱数バイトを確保する
  const bytes = new Uint8Array(INBOUND_TOKEN_LENGTH);
  // Web Crypto で暗号学的乱数を埋める
  globalThis.crypto.getRandomValues(bytes);
  // 各バイトを許可文字集合へ写像して 1 文字ずつ積む
  let token = '';
  for (let i = 0; i < bytes.length; i++) {
    // バイト値を文字集合長で割った余りでインデックスを決める (軽微な偏りは許容)
    token += INBOUND_TOKEN_ALPHABET[bytes[i] % INBOUND_TOKEN_ALPHABET.length];
  }
  // 組み立てたトークンを返す
  return token;
}

// 文字列を指定長で安全に切り詰める内部ヘルパー (上限超過時のみ切る)
function clamp(value: string, max: number): string {
  // 上限以内ならそのまま、超えていれば先頭 max 文字に切り詰める
  return value.length > max ? value.slice(0, max) : value;
}

// プロバイダ Webhook が送ってきたフィールド群を正規化済みの受信メールに変換する。
// 必須情報 (宛先トークン・送信者・本文) が揃わない場合は理由付きで失敗を返す (例外にせず呼び出し側で分岐)。
export function parseInboundEmail(
  fields: {
    to?: string | null; // 宛先 (ヘッダ or envelope 由来)
    from?: string | null; // 送信者 (ヘッダ or envelope 由来)
    subject?: string | null; // 件名
    text?: string | null; // テキスト本文
  },
  options?: { expectedDomain?: string | null }, // 宛先ドメイン検証 (任意)
): { ok: true; email: ParsedInboundEmail } | { ok: false; reason: string } {
  // 宛先からテナント特定トークンを取り出す (ドメイン不一致なら null)
  const recipientToken = extractInboundToken(fields.to, options?.expectedDomain);
  // トークンが取れなければルーティング不能 → 失敗
  if (!recipientToken) {
    return { ok: false, reason: '宛先アドレスから取り込み先を特定できませんでした' };
  }
  // 送信者アドレスを正規化する
  const senderAddress = extractEmailAddress(fields.from);
  // 送信者が取れなければ誰の問い合わせか確定できない → 失敗
  if (!senderAddress) {
    return { ok: false, reason: '送信者アドレスを特定できませんでした' };
  }
  // 表示名は "名前 <addr>" の名前部分があれば使い、無ければアドレスをそのまま表示名にする
  const rawFrom = (fields.from ?? '').trim();
  const nameMatch = rawFrom.match(/^([^<]+)<[^>]+>$/);
  // 表示名を抽出し前後空白と囲みクォートを除去する (取れなければアドレスを流用)
  const senderName = nameMatch
    ? nameMatch[1]
        .trim()
        .replace(/^"(.*)"$/, '$1')
        .trim() || senderAddress
    : senderAddress;
  // 件名は空白だけなら既定タイトルにフォールバックし、上限まで切り詰める
  const subjectRaw = (fields.subject ?? '').trim();
  const subject = clamp(
    subjectRaw.length > 0 ? subjectRaw : INBOUND_DEFAULT_SUBJECT,
    INBOUND_SUBJECT_MAX,
  );
  // 本文は上限まで切り詰める (空でも許容: 件名だけのメールもあり得る)
  const body = clamp((fields.text ?? '').trim(), INBOUND_BODY_MAX);
  // 正規化済みの受信メールを返す
  return {
    ok: true,
    email: {
      recipientToken,
      senderAddress,
      senderName: clamp(senderName, INBOUND_ADDRESS_MAX),
      subject,
      body,
    },
  };
}
