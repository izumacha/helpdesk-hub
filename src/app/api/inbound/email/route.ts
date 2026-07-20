/**
 * Inbound email webhook (Phase 2「メール取り込み」/ docs/smb-dx-pivot-plan.md §4 / §5.3).
 *
 * メールプロバイダ (SendGrid Inbound Parse / Postmark Inbound / Amazon SES 等) が、
 * テナント専用の転送アドレス (例: <inboundToken>@inbox.helpdesk-hub.app) 宛に届いた
 * メールをこのエンドポイントへ POST する。受信メールを 1 件の問い合わせ (Ticket) に変換する。
 *
 * セキュリティ要点 (§9):
 *  - Webhook は認証セッションを持たないため、共有シークレット (INBOUND_EMAIL_SECRET) を
 *    定数時間比較で検証し、なりすまし POST を弾く。シークレット未設定なら起動時ではなく
 *    リクエスト時に fail-closed (500) で拒否する (誤って無防備な取り込み口を開けないため)。
 *  - 宛先ローカルパート (inboundToken) からテナントを特定する。クロステナント漏洩を防ぐため、
 *    送信者は「そのテナントに所属する既知メンバー」のみ起票を許可し、未知送信者は隔離 (起票せず
 *    202 を返してプロバイダの再送ループを避ける ＝ 計画 §8「不明送信者は隔離キューへ」の最小版)。
 */

// JSON レスポンスヘルパー
import { NextResponse } from 'next/server';
// ページキャッシュ無効化 (スレッド継続でコメント追記したチケット詳細を再描画させる)
import { revalidatePath } from 'next/cache';
// 監査で発見したギャップ対応: 共有シークレットの定数時間比較は LINE Webhook / 内部 cron
// エンドポイント (trial-reminders / sla-reminders) と同じ共通ヘルパーを使う (§6 DRY。
// このルートだけ timingSafeEqual を直接使った自前実装が残っていた)
import { constantTimeStringEqual } from '@/lib/timing-safe-compare';
// データ層 (テナント / ユーザー / チケットのリポジトリ束 + トランザクション境界)
import { repos, uow } from '@/data';
// Webhook 再送に対する冪等起票の共通ヘルパー (LINE/メールで共有)。フォローアップ (2026-07-13):
// 添付ファイルをチケット起票と同一トランザクションで保存するための onCreated フックを追加した
import {
  createTicketIdempotent,
  emailMessageIdempotencyOps,
} from '@/lib/idempotent-ticket-creation';
// 添付ファイルの寛容版検証ヘルパー (件数/MIME/サイズ/マジックバイト。Web フォーム・コメント投稿の
// 全件一括版 validateUploadedFiles とは異なり、1 件でも違反があっても全体を失敗させない。
// この Webhook にはユーザーへ即座にフィードバックして再送信させられる画面が無いため)
import { validateUploadedFilesLenient } from '@/lib/validations/attachment';
// 添付ファイルのストレージ保存 / 失敗時クリーンアップの共通ヘルパー (POST /api/tickets・
// POST /api/tickets/[id]/comments と共有。/code-review ultra 指摘対応: 3 箇所目の重複を解消)
// checkTicketAttachmentQuota はチケット当たりの添付総数上限チェック (監査で発見したギャップ対応)
import {
  persistAttachments,
  cleanupWrittenAttachments,
  checkTicketAttachmentQuota,
} from '@/lib/attachment-persistence';
// 新規起票時の初期ステータスを mode から決める共通ルール (Web フォーム起票と単一の源を共有)
import { initialStatusForMode } from '@/domain/ticket-status';
// コメント通知の宛先決定 (Web フォーム経由コメントと共有するヘルパー)
import { resolveCommentRecipients } from '@/lib/comment-recipients';
// 未読件数を SSE で即時配信するヘルパー (コメント追記時の通知扇形)
import {
  broadcastUnreadCountToMany,
  notifyAgentsOfNewTicket,
} from '@/features/notifications/notify';
// 受信メールの正規化ヘルパー (純粋関数) と生ヘッダ読み取り、送信元認証 (SPF/DKIM/DMARC) の判定
import {
  parseInboundEmail,
  readRawHeader,
  extractAuthResults,
  evaluateInboundAuth,
} from '@/lib/inbound-email';
// エージェント権限判定 (スレッド追記の RBAC に使用)
import { isAgent } from '@/lib/role';
// 公開エンドポイントの流量制限 (§9: DoS / リソース枯渇防止。Route Handler 向け共通ラッパー)
import { checkRouteRateLimit } from '@/lib/route-rate-limit';
// 優先度から解決期限を計算する SLA ヘルパー (Web フォーム起票と同じ既定値に揃える)
import { calculateFirstResponseDueAt, calculateResolutionDueAt } from '@/lib/sla';
// 受領自動返信 (メンバー改善 #1) のための送信基盤・本文生成・リンク組み立てヘルパー
import { getEmailSender } from '@/lib/email';
import { renderTicketReceivedEmail, buildTicketUrl } from '@/lib/ticket-email';
import { resolveAppBaseUrl } from '@/lib/app-url';
// 受領メールに付ける決定的 Message-ID (依頼者が受領メールに返信したら同じチケットへ追記できるようにする)
import { buildReplyMessageId, resolveMessageIdDomain } from '@/lib/email-message-id';
// 受付番号 (短縮 ID) の共有フォーマッタ (画面のチケット詳細ヘッダと同じ表記)
import { formatTicketRef } from '@/lib/ticket-ref';
// メール取り込み機能のプランゲート (§6.1 料金プラン: Free では利用不可)
import { isEmailInboundAllowed, resolveEffectivePlan } from '@/lib/plan-guard';
// Phase 4: Slack/Teams/Chatwork 外部通知ヘルパー (Web フォーム・LINE 取り込み・CSV インポートと共有)
import { notifyNewTicketOutbound } from '@/lib/outbound-notify';
// Phase 4 課金: 月間チケット上限チェック (Web フォーム・CSV インポートと共有)。
// フォローアップ (2026-07-13): 添付累計サイズ上限チェックも Web フォーム・コメント投稿と共有する
import { getMonthlyTicketQuota, checkAttachmentQuota } from '@/lib/tenant-plan';
// 隔離理由の型 (§3.2 フォローアップ: 隔離記録の永続化に使う)
import type { QuarantineReason } from '@/domain/types';
// 隔離記録の書き込み共通ヘルパー (LINE 取り込みと共有。§6 DRY)
import { recordQuarantineSafe } from '@/lib/quarantine';

// このルートは Node ランタイムで動かす (node:crypto / Prisma を使うため Edge では動かない)
export const runtime = 'nodejs';

// 受信ボディの最大バイト数 (一般的なメール送信上限の 25MB)。これを超える Content-Length は
// パース前に拒否し、巨大ボディの全読み込みによるメモリ枯渇 (§9) を防ぐ
const MAX_INBOUND_BODY_BYTES = 25 * 1024 * 1024;
// テナント単位の取り込み流量上限。共有シークレット漏洩時でもテナントあたりの起票を抑える。
// (キーはテナント ID なのでバケット数は実在テナント数で頭打ち = メモリも有界)
const INBOUND_RATE_LIMIT = { limit: 120, windowMs: 60_000 } as const;

// ボディサイズ超過を示す専用エラー。Error のサブクラスにすることで POST ハンドラの catch 節が
// instanceof 判定で 413 と 400 を区別できる (汎用 Error では両者を区別できず 400 になってしまう)。
class BodyTooLargeError extends Error {
  // スーパークラスに日本語メッセージを渡す (ログに出たときに原因が読める)
  constructor() {
    // Error の message プロパティを設定する
    super('リクエストが大きすぎます');
    // this.name を明示設定する。設定しないと err.name が 'Error' になり構造化ロガーで誤分類される
    // (RateLimitError が this.name を設定しているのと同じ理由 - src/lib/rate-limit.ts:37 参照)
    this.name = 'BodyTooLargeError';
  }
}

// リクエストから提示されたシークレットを取り出す。
// シークレットは x-inbound-secret ヘッダのみから読む。URL クエリパラメータへのフォールバックは
// アクセスログ・プロキシログにシークレット値が平文で記録されるリスクがあるため廃止した (§9)。
// Webhook プロバイダ側の設定で「カスタムヘッダ」として追加する方式に統一すること。
function readProvidedSecret(req: Request): string | null {
  // 専用ヘッダから読む (ヘッダ以外の方法は受け付けない)。
  // trim() でプロキシが付加した余分な空白を除去する。空白だけなら null 扱いにする
  return req.headers.get('x-inbound-secret')?.trim() || null;
}

// 受信メール 1 通分のフィールドの共通形 (to / from / subject / text に加え、スレッド継続用ヘッダ)
interface InboundFields {
  to?: string | null; // 宛先 (ルーティング)
  from?: string | null; // 送信者 (本人特定)
  subject?: string | null; // 件名
  text?: string | null; // テキスト本文
  messageId?: string | null; // この受信メールの Message-ID
  inReplyTo?: string | null; // In-Reply-To ヘッダ (直接の返信元)
  references?: string | null; // References ヘッダ (スレッド上の Message-ID 列)
  spf?: string | null; // 送信元認証: SPF 結果 (プロバイダ算出。SendGrid の "SPF" フィールド等)
  dkim?: string | null; // 送信元認証: DKIM 結果 (プロバイダ算出。SendGrid の "dkim" フィールド等)
  authenticationResults?: string | null; // 送信元認証: 生 Authentication-Results ヘッダ (汎用)
  autoSubmitted?: string | null; // RFC 3834 の Auto-Submitted ヘッダ (自動応答メール判定 = ループ防止)
  precedence?: string | null; // Precedence ヘッダ (bulk/list/junk なら自動配信・メーリングリスト判定)
  // フォローアップ (2026-07-13): 監査で発見したギャップの解消。SendGrid Inbound Parse は
  // 添付ファイルを "attachments" (件数) + "attachment1".."attachmentN" (File) フィールドで送るが、
  // 従来これらを一切読んでおらず、写真を送るだけで済ませたい SMB ペルソナ (§1.2) の主要ユースケース
  // (問い合わせに画像を添付) がメール経由では実現できていなかった (JSON パスには File 型が無いため
  // 常に空配列。multipart のみ)
  attachments: File[];
}

// 受信メール 1 通分のフィールドを、JSON / multipart のどちらのボディからでも取り出して共通形に揃える。
async function readInboundFields(req: Request): Promise<InboundFields> {
  // Content-Type を小文字化して判定 (大文字小文字はメディアタイプ上区別しない)
  const contentType = (req.headers.get('content-type') ?? '').toLowerCase();
  // multipart/form-data (SendGrid Inbound Parse 等) は FormData として読む
  if (
    contentType.includes('multipart/form-data') ||
    contentType.includes('application/x-www-form-urlencoded')
  ) {
    // ボディをバイト列として読み取る。req.formData() は生バイト数を隠蔽するため、
    // 先に arrayBuffer() で読んでサイズを確認してから FormData にパースする。
    // chunked 転送など Content-Length なしで大きなボディを送り込む攻撃への対策 (§9)。
    const rawBuffer = await req.arrayBuffer();
    // バイト列の実サイズが上限を超えていれば専用エラーを投げる (POST ハンドラが 413 にマップする)
    if (rawBuffer.byteLength > MAX_INBOUND_BODY_BYTES) {
      // BodyTooLargeError を投げると POST の catch 節が 413 を返す (汎用 Error では 400 になる)。
      // warn ログは catch 節で 1 度だけ出すため、ここでは二重に出さない
      throw new BodyTooLargeError();
    }
    // サイズ検査済みのバイト列を FormData にパースする。
    // req.formData() は既にボディを消費しているため、同じバイト列から新規 Request を組み立てて
    // formData() を呼ぶ。Content-Type ヘッダ (boundary パラメータを含む) を引き継ぐ。
    const form = await new Request('http://x', {
      method: 'POST',
      headers: { 'content-type': req.headers.get('content-type') ?? '' },
      body: rawBuffer,
    }).formData();
    // SendGrid は実際の RCPT を envelope (JSON 文字列) に入れるため、あれば優先的に使う
    const envelopeRaw = form.get('envelope');
    // envelope から宛先・送信者を補完する変数 (取れなければヘッダ値を使う)
    let envTo: string | null = null;
    let envFrom: string | null = null;
    if (typeof envelopeRaw === 'string' && envelopeRaw.length > 0) {
      try {
        // envelope は {"to":["..."],"from":"..."} 形式の JSON
        const env = JSON.parse(envelopeRaw) as { to?: unknown; from?: unknown };
        // to は配列想定。先頭要素を採用する
        if (Array.isArray(env.to) && typeof env.to[0] === 'string') envTo = env.to[0];
        // from は文字列想定
        if (typeof env.from === 'string') envFrom = env.from;
      } catch (err) {
        // envelope のパース失敗は致命ではない (ヘッダ値で代替できる)。警告として記録し握り潰さない
        console.warn('[POST /api/inbound/email] failed to parse envelope JSON', err);
      }
    }
    // FormData の値を string | null に正規化する小ヘルパー
    const str = (v: FormDataEntryValue | null): string | null => (typeof v === 'string' ? v : null);
    // SendGrid 等は個別の Message-ID / In-Reply-To フィールドを持たないことがあるため、
    // 生ヘッダ (headers フィールド) からのフォールバック抽出も用意する (スレッド継続用)。
    const rawHeaders = str(form.get('headers'));
    // フォローアップ (2026-07-13): 添付ファイルを抽出する。SendGrid Inbound Parse は
    // "attachments" フィールドに件数を、"attachment1".."attachmentN" に各ファイルを渡す規約。
    // 件数フィールドの値をそのままループ回数にすると、細工した巨大な値を送られたときに無駄な
    // ループが走るため、実利用であり得ない上限で頭打ちする (§9 DoS 対策の一環。実際の添付件数
    // 上限は後段の validateUploadedFiles の MAX_ATTACHMENTS_PER_UPLOAD が別途強制する)。
    const ATTACHMENT_LOOKUP_MAX = 20;
    const attachmentCountRaw = parseInt(str(form.get('attachments')) ?? '', 10);
    const attachmentCount =
      Number.isFinite(attachmentCountRaw) && attachmentCountRaw > 0
        ? Math.min(attachmentCountRaw, ATTACHMENT_LOOKUP_MAX)
        : 0;
    const attachments: File[] = [];
    for (let i = 1; i <= attachmentCount; i++) {
      const entry = form.get(`attachment${i}`);
      if (entry instanceof File) attachments.push(entry);
    }
    // 宛先 (ルーティング): envelope の RCPT を優先する (ヘッダ To より実配送先として確実)。
    // 送信者 (本人特定): ヘッダ From を優先する (人間が送った差出人。envelope from=MAIL FROM は
    // 戻り先で本人性が弱い)。本人性は既知メンバー判定に加え、INBOUND_EMAIL_AUTH=enforce のとき
    // 下流で SPF/DKIM/DMARC の明示 fail を隔離して守る (#147 で実装)。
    return {
      to: envTo ?? str(form.get('to')),
      from: str(form.get('from')) ?? envFrom,
      subject: str(form.get('subject')),
      text: str(form.get('text')),
      // Message-ID 系は個別フィールド優先、無ければ生ヘッダから読む
      messageId: str(form.get('message-id')) ?? readRawHeader(rawHeaders, 'Message-ID'),
      inReplyTo: str(form.get('in-reply-to')) ?? readRawHeader(rawHeaders, 'In-Reply-To'),
      references: str(form.get('references')) ?? readRawHeader(rawHeaders, 'References'),
      // 送信元認証: SendGrid は SPF / dkim を個別フィールドで渡す。汎用は生ヘッダから読む。
      // SendGrid は 'SPF'、Postmark は 'Spf'、その他は小文字 'spf' — すべて試みる
      spf: str(form.get('SPF')) ?? str(form.get('Spf')) ?? str(form.get('spf')),
      dkim: str(form.get('dkim')),
      authenticationResults: readRawHeader(rawHeaders, 'Authentication-Results'),
      // 自動応答判定用ヘッダ (multipart では生ヘッダから読む。ループ防止に使う)
      autoSubmitted: readRawHeader(rawHeaders, 'Auto-Submitted'),
      precedence: readRawHeader(rawHeaders, 'Precedence'),
      attachments, // 添付ファイル (フォローアップ 2026-07-13)
    };
  }
  // それ以外は JSON ボディとして読む (テスト・自前連携向け)。
  // 注意: JSON パスでは spf / dkim フィールドを呼び出し元が自由に指定できる。INBOUND_EMAIL_SECRET を
  // 知る者が { spf: 'pass' } を渡せば INBOUND_EMAIL_AUTH=enforce をバイパスできるが、これは設計上の
  // 許容トレードオフ — JSON パスはシークレット保持者限定のテスト・内部連携用途であり、本番 SendGrid は
  // multipart/form-data を使う。運用では JSON パスを本番プロバイダに開かないこと (§9)。
  // req.json() はボディ全体をメモリに乗せてからパースするため、先に rawText として読んでサイズを検査する
  const rawText = await req.text();
  // UTF-8 バイト数で上限を検査する (rawText.length は UTF-16 コードユニット数で不正確なため Buffer 経由)
  if (Buffer.byteLength(rawText, 'utf8') > MAX_INBOUND_BODY_BYTES) {
    // BodyTooLargeError を投げると POST の catch 節が 413 を返す (汎用 Error では 400 になってしまう)。
    // warn ログは catch 節で 1 度だけ出すため、ここでは二重に出さない
    throw new BodyTooLargeError();
  }
  // サイズ検査済みの文字列を JSON としてパースする (unknown で受けて次行で型を絞り込む)
  const parsed: unknown = JSON.parse(rawText);
  // プレーンオブジェクト以外 (数値・配列・null 等) なら 400 にマップする (§9 入力検証)。
  // ここで throw した Error は下の catch 節が 400 として返す
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('JSON ボディはオブジェクトである必要があります');
  }
  // 型ガードを通過したので Record<string, unknown> にキャストしてよい
  const body = parsed as Record<string, unknown>;
  // 文字列フィールドだけを取り出す小ヘルパー
  const pick = (k: string): string | null =>
    typeof body[k] === 'string' ? (body[k] as string) : null;
  return {
    to: pick('to'),
    from: pick('from'),
    subject: pick('subject'),
    text: pick('text'),
    // camelCase / ヘッダ表記 (ハイフン) のどちらの JSON キーでも受ける
    messageId: pick('messageId') ?? pick('message-id'),
    inReplyTo: pick('inReplyTo') ?? pick('in-reply-to'),
    references: pick('references'),
    // 送信元認証: 個別キー (SPF/spf, dkim) と生ヘッダ (authentication-results) のどちらも受ける
    spf: pick('SPF') ?? pick('spf'),
    dkim: pick('dkim'),
    authenticationResults: pick('authenticationResults') ?? pick('authentication-results'),
    // 自動応答判定用ヘッダ (camelCase / ヘッダ表記の両方を受ける)
    autoSubmitted: pick('autoSubmitted') ?? pick('auto-submitted'),
    precedence: pick('precedence') ?? pick('Precedence'),
    // JSON には File 型が無いため常に空配列 (JSON パスはテスト・内部連携専用。上のコメント参照)
    attachments: [],
  };
}

// 受信メールが「自動配信メール」かどうかを判定する (受領自動返信のループ防止 §9 fail-safe)。
// 自動応答や配信専用 (no-reply) 宛に受領メールを返すと、相手も自動返信して無限ループ (メールストーム)
// になりうるため、自動配信と分かるメールには受領返信を送らない。
function isAutomatedEmail(fields: InboundFields): boolean {
  // RFC 3834: Auto-Submitted が "no" 以外 (auto-generated / auto-replied 等) なら自動応答メール
  const autoSubmitted = (fields.autoSubmitted ?? '').trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') return true;
  // Precedence が bulk / list / junk はメーリングリストや一斉配信なので自動返信しない
  const precedence = (fields.precedence ?? '').trim().toLowerCase();
  if (precedence === 'bulk' || precedence === 'list' || precedence === 'junk') return true;
  // いずれにも該当しなければ通常の人手メールとみなす
  return false;
}

// 初回メール起票の受領自動返信を 1 通送る (メンバー改善 #1)。ベストエフォート: 送信失敗で 500 を返すと
// プロバイダ再送 → 二重起票になりかねないため、例外は握ってログに残す (副作用は send と Message-ID 登録のみ)。
async function sendReceivedAck(args: {
  to: string; // 送信元 (= 既知メンバー) のメールアドレス
  ticketId: string; // 作成されたチケット ID (受付番号・URL 構築用)
  ticketTitle: string; // チケット件名 (メール本文用)
  tenantId: string; // テナント (Message-ID 対応表のスコープ)
}): Promise<void> {
  const { to, ticketId, ticketTitle, tenantId } = args;
  try {
    // メール内リンクのベース URL を解決 (production で NEXTAUTH_URL 未設定なら throw → 下で握る)
    const baseUrl = resolveAppBaseUrl();
    // チケット詳細ページへの導線 URL を組み立てる
    const ticketUrl = buildTicketUrl(baseUrl, ticketId);
    // 件名 / 本文 (Text / HTML) を純粋ヘルパーで構築 (受付番号は画面と同じ短縮 ID 表記)
    const { subject, text, html } = renderTicketReceivedEmail({
      ticketTitle,
      ticketRef: formatTicketRef(ticketId),
      ticketUrl,
    });
    // 受領メールに決定的 Message-ID を付与し、依頼者がこの受領メールに返信したら In-Reply-To 経由で
    // 同じチケットへ追記できるよう、返信メールと同じ仕組みで対応表へ先に登録する (冪等)
    const ackMessageId = buildReplyMessageId(ticketId, resolveMessageIdDomain());
    await repos.emailThreads.register({
      messageId: ackMessageId.normalized, // 山括弧なしの正規化値 (受信側の表記と一致)
      ticketId,
      tenantId,
    });
    // 設定された EmailSender (console / smtp) 経由で送信。Auto-Submitted で相手の自動返信ループを防ぐ
    await getEmailSender().send({
      to,
      subject,
      text,
      html,
      messageId: ackMessageId.header,
      // RFC 3834: このメール自身が自動応答であることを示し、相手サーバの自動返信を抑止する
      headers: { 'Auto-Submitted': 'auto-replied' },
    });
  } catch (err) {
    // 送信失敗はサーバログに残すだけ (チケットは既に作成済みで、起票自体は成功扱いにする)
    console.error('[POST /api/inbound/email] 受領自動返信メールの送信に失敗しました', err);
  }
}

// §3.2 フォローアップ (2026-07-09): 隔離した受信メールを永続化する。
// 以前は console.warn のサーバーログにしか残らず admin から一切確認できなかった (/quarantine
// 一覧画面が唯一の閲覧手段になる)。記録の書き込み自体は待ち合わせる (呼び出し元は await する) が、
// 記録失敗が隔離レスポンス自体を失敗させないようにする (SettingsAuditLog と同じ「記録失敗は
// 本来の処理に影響させない」方針。§9 fail-safe)。
// /code-review ultra 指摘対応: 当初「レスポンスを遅延させない」とも書いていたが、実際には
// await しているため応答は記録の完了を待つ。誤解を招く記述だったため実態に合わせて修正した。
// フォローアップ (2026-07-13): try/catch + ログの定型部分は LINE 取り込みの recordLineQuarantine と
// 同型の重複だったため src/lib/quarantine.ts::recordQuarantineSafe へ共通化した (§6 DRY)
async function recordQuarantine(
  tenantId: string,
  reason: QuarantineReason,
  email: { senderAddress: string; senderName: string; subject: string },
): Promise<void> {
  await recordQuarantineSafe(
    {
      tenantId,
      channel: 'email',
      reason,
      senderAddress: email.senderAddress,
      senderName: email.senderName,
      subject: email.subject,
    },
    '[POST /api/inbound/email]',
  );
}

// POST /api/inbound/email : 受信メールを 1 件の問い合わせに変換する
export async function POST(req: Request) {
  // 共有シークレットを環境変数から読む。未設定なら fail-closed (無防備な取り込み口を開けない)
  const expectedSecret = process.env.INBOUND_EMAIL_SECRET?.trim();
  if (!expectedSecret) {
    // 設定漏れはサーバログにエラーとして残し、外部には詳細を出さない 500 を返す
    console.error('[POST /api/inbound/email] INBOUND_EMAIL_SECRET is not configured');
    return NextResponse.json({ error: 'メール取り込みは利用できません' }, { status: 500 });
  }

  // 提示されたシークレットを取り出して定数時間比較する (ヘッダのみ受け付ける)
  const provided = readProvidedSecret(req);
  if (!provided || !constantTimeStringEqual(provided, expectedSecret)) {
    // 不一致は 401 (なりすまし POST を拒否)
    return NextResponse.json({ error: '認証に失敗しました' }, { status: 401 });
  }

  // Content-Length が上限超過なら本体を読む前に 413 で弾く (巨大ボディのメモリ枯渇防止 §9)。
  // || '-1' で null (ヘッダ無し) と空文字列 ('Content-Length: ') の両方を -1 にまとめる。
  // ?? は null/undefined しか補填しないため、空文字列を明示的に処理するために || を使う。
  // -1 は MAX_INBOUND_BODY_BYTES より小さいのでプリチェックはスルーし、後段の読み込み後チェックに委ねる。
  // なお、このエンドポイントは共有シークレット認証が先に通っているため、
  // 未認証リクエストがボディ読み込みまで到達しない (LINE ルートより攻撃面が限定的)。
  const contentLength = Number(req.headers.get('content-length') || '-1');
  if (Number.isFinite(contentLength) && contentLength > MAX_INBOUND_BODY_BYTES) {
    // サイズ超過はサーバーログに残し、外部には詳細を出さない 413 を返す
    console.warn(
      `[POST /api/inbound/email] request body too large (header): ${contentLength} bytes`,
    );
    return NextResponse.json({ error: 'メールが大きすぎます' }, { status: 413 });
  }

  // 受信メールのフィールドを取り出す (JSON / multipart 両対応)
  let fields: InboundFields;
  try {
    // ボディを読んでフィールドを取り出す。BodyTooLargeError または汎用 Error を投げることがある
    fields = await readInboundFields(req);
  } catch (err) {
    // BodyTooLargeError は 413 にマップする (Content-Length ヘッダなし chunked 転送のサイズ超過)
    if (err instanceof BodyTooLargeError) {
      // サイズ超過はサーバーログに残す (外部には詳細を出さない §9)
      console.warn('[POST /api/inbound/email] request body too large (actual)');
      // 413 を返す (Content-Length 事前チェックと同じステータスに揃える)
      return NextResponse.json({ error: 'メールが大きすぎます' }, { status: 413 });
    }
    // それ以外のパースエラーは 400 (握り潰さずログに残す)
    console.error('[POST /api/inbound/email] failed to read request body', err);
    // 形式不正は 400 で返す (外部には詳細を出さない)
    return NextResponse.json({ error: 'リクエストの形式が正しくありません' }, { status: 400 });
  }

  // 宛先ドメインの検証用 (任意設定)。設定されていれば宛先ドメイン一致を必須にする
  const expectedDomain = process.env.INBOUND_EMAIL_DOMAIN?.trim() || null;
  // フィールドを正規化する (宛先トークン・送信者・件名・本文)
  const parsed = parseInboundEmail(fields, { expectedDomain });
  // 必須情報が欠けていれば 422 (起票できない理由はログのみに残し、外部へは汎用メッセージを返す §9)
  if (!parsed.ok) {
    // 詳細理由はサーバーログに記録する (外部に返すと内部ルーティング構造が推測される)
    console.warn('[POST /api/inbound/email] unprocessable email', parsed.reason);
    // 外部には汎用メッセージのみ返す (内部理由を公開しない)
    return NextResponse.json({ error: 'メールを処理できませんでした' }, { status: 422 });
  }
  // 正規化済みの受信メール
  const email = parsed.email;

  // 宛先トークンから取り込み先テナントを特定する
  const tenant = await repos.tenants.findByInboundToken(email.recipientToken);
  // 該当テナントが無ければ 404 (どのトークンが存在するかを推測されないよう詳細は出さない)
  if (!tenant) {
    console.warn('[POST /api/inbound/email] no tenant for inbound token');
    return NextResponse.json({ error: '取り込み先が見つかりません' }, { status: 404 });
  }

  // テナント単位で取り込み流量を制限する (シークレット漏洩時の起票スパムを抑える §9)。
  // 超過時は 429 + Retry-After で返し、プロバイダの後刻リトライに委ねる。
  // /code-review ultra 指摘対応: 以前はこのチェックがプランゲートより後にあり、プランゲート
  // (隔離のみで console.warn だけの軽い分岐だった) には実質レート制限が効いていなかった。
  // 隔離記録の永続化 (recordQuarantine) を追加した今、プランゲート分岐が DB 書き込みを伴う
  // ようになったため、レート制限より前に置いたままだと共有シークレットを知る者がプラン未対応
  // テナント宛に大量送信するだけで QuarantinedEmail テーブルへの書き込みを無制限に発生させられる
  // (§9 DoS/リソース枯渇防止に反する)。他の隔離理由と同じくレート制限を先に通す順序に変更した。
  const rateLimitResponse = checkRouteRateLimit(
    `inbound-email:${tenant.id}`,
    INBOUND_RATE_LIMIT,
    '取り込みが混み合っています',
  );
  if (rateLimitResponse) return rateLimitResponse;

  // §7.2 Free trial 中 (Standard 相当) ならメール取り込みも解禁する。以降のプラン依存判定
  // (このゲートと月間チケット上限) は全てこの実効プランを使う
  const effectivePlan = resolveEffectivePlan(tenant.subscriptionPlan, tenant.trialEndsAt);

  // プランゲート: メール取り込みは Standard 以上のみ (Free では利用不可 §6.1 料金プラン)。
  // UI 非表示に頼らずサーバー側 (Webhook 受信口) で強制する。未知送信者と同様に隔離扱いにして
  // 202 を返し、どのテナントが対象外かをレスポンスから推測されないようにする (§9)。
  if (!isEmailInboundAllowed(effectivePlan)) {
    console.warn('[POST /api/inbound/email] quarantined: email inbound not allowed for plan', {
      plan: effectivePlan,
    });
    await recordQuarantine(tenant.id, 'plan_gate', email);
    return NextResponse.json({ status: 'quarantined' }, { status: 202 });
  }

  // 送信元ドメイン認証 (SPF/DKIM/DMARC) の検証 (§8 リスク表「送信元ドメイン検証」)。
  // プロバイダが算出した結果を消費し、ポリシーが 'enforce' のとき明示 'fail' なら隔離する。
  // 既定 (INBOUND_EMAIL_AUTH 未設定 = off) では従来どおり検証せず、既存メンバー判定に委ねる。
  // From 詐称 (既知メンバーのアドレス偽装) は、結果を出すプロバイダ構成ではここで弾かれる。
  const authPolicy = process.env.INBOUND_EMAIL_AUTH ?? '';
  const authResults = extractAuthResults({
    spf: fields.spf,
    dkim: fields.dkim,
    authenticationResults: fields.authenticationResults,
  });
  if (evaluateInboundAuth(authResults, authPolicy) === 'quarantine') {
    // 隔離: 起票せず 202 を返す (プロバイダの再送ループを避ける)。判定値のみ記録し PII は出さない
    console.warn('[POST /api/inbound/email] quarantined: sender domain authentication failed', {
      spf: authResults.spf,
      dkim: authResults.dkim,
      dmarc: authResults.dmarc,
    });
    await recordQuarantine(tenant.id, 'auth_fail', email);
    // 外部レスポンスには reason を含めない (SPF/DKIM ポリシー適用状態を推測させない §9)
    return NextResponse.json({ status: 'quarantined' }, { status: 202 });
  }

  // 送信者がそのテナントの既知メンバーかを確認する。
  // findByEmail はテナント横断のため、必ず tenantId 一致まで検査してクロステナント起票を防ぐ。
  const sender = await repos.users.findByEmail(email.senderAddress);
  if (!sender || sender.tenantId !== tenant.id) {
    // 未知送信者は隔離扱い: 起票せず 202 を返す (プロバイダの再送ループを避けつつ無視する)
    console.warn('[POST /api/inbound/email] quarantined: unknown sender for tenant');
    await recordQuarantine(tenant.id, 'unknown_sender', email);
    return NextResponse.json({ status: 'quarantined' }, { status: 202 });
  }

  // フォローアップ (2026-07-13): 監査で発見したギャップの解消。添付ファイルを検証する。
  // Web フォーム/コメント投稿と異なり、この Webhook にはユーザーへ即時フィードバックする画面が無い
  // (送信者はプロバイダの応答を見ない)。そのため寛容版 (validateUploadedFilesLenient) を使い、
  // 1 件でも違反があってもメール全体 (起票/追記) を止めず、違反したファイルだけを除外して処理を
  // 継続する。/code-review ultra 指摘対応: 当初は全件一括版 (validateUploadedFiles) を使い
  // 検証失敗時に添付を全て捨てていたが、有効な写真が複数枚あるメールで 1 件でも非対応形式が
  // 混在すると有効な写真まで巻き添えで消えてしまい、写真添付という本機能の目的を損なっていた。
  const attachmentValidation = await validateUploadedFilesLenient(fields.attachments);
  let validatedAttachments = attachmentValidation.files;
  const { droppedCount } = attachmentValidation;
  if (droppedCount > 0) {
    console.warn('[POST /api/inbound/email] some attachments were rejected and dropped', {
      droppedCount,
      keptCount: validatedAttachments.length,
    });
  }
  // 添付が残っていれば、テナントの累計サイズ上限 (§6.1 Standard「添付1GB」) も確認する。
  // Web フォームと同じ理由で必ず rawPlan (tenant.subscriptionPlan) を渡す (effectivePlan だと
  // Free trial 中に Free=無制限 → Standard=1GB へ上限が逆に厳しくなってしまう。tenant-plan.ts 参照)
  if (validatedAttachments.length > 0) {
    const newAttachmentBytes = validatedAttachments.reduce((sum, f) => sum + f.size, 0);
    const attachmentQuotaCheck = await checkAttachmentQuota(
      tenant.id,
      newAttachmentBytes,
      tenant.subscriptionPlan,
    );
    if (!attachmentQuotaCheck.ok) {
      console.warn('[POST /api/inbound/email] attachments exceed quota, continuing without them', {
        reason: attachmentQuotaCheck.message,
      });
      validatedAttachments = [];
    }
  }

  // 冪等性: この受信メールの Message-ID を既に取り込み済みなら、二重起票/二重コメントを避ける。
  // Webhook は at-least-once 配送 (再送あり) なので、同じ Message-ID を見たら過去のチケットを返す。
  // 注意: Message-ID が取れない (null) メールはこの重複判定が効かず、新規起票パスと同じ at-least-once
  // 挙動 (再送で重複しうる) になる。実メールはほぼ必ず Message-ID を持つため通常は冪等に処理される。
  if (email.messageId) {
    const already = await repos.emailThreads.findTicketIdByMessageIds([email.messageId], tenant.id);
    if (already) {
      // 既に処理済み: 何もせず 200 を返す (プロバイダの再送ループを止める)
      return NextResponse.json({ status: 'duplicate', ticketId: already }, { status: 200 });
    }
  }

  // スレッド継続 (Phase 2 / L130): 参照 Message-ID (In-Reply-To / References) から既存チケットを
  // 逆引きできれば、新規起票せず「そのチケットへのコメント追記」として取り込む。
  const threadTicketId =
    email.referenceIds.length > 0
      ? await repos.emailThreads.findTicketIdByMessageIds(email.referenceIds, tenant.id)
      : null;
  if (threadTicketId) {
    // 紐づくチケットを tenantId スコープで取得 (別テナント ID なら null)
    const ticket = await repos.tickets.findById(threadTicketId, tenant.id);
    if (ticket) {
      // 送信者がエージェント/管理者か (通知扇形と RBAC の判定に使う)
      const senderIsAgent = isAgent(sender.role);
      // 初回応答日時の記録に使う基準時刻 (Web フォーム経由コメント/comments/route.ts と同じ扱い)
      const now = new Date();
      // 追記の権限: エージェント、または自分が起票したチケットのみ (第三者メンバーの混線/露出を防ぐ)。
      // 権限の無いメンバーは隔離扱い (202) にして無視する。
      // 本人性 (§9 / §8 リスク表): 共有シークレット + 取り込みトークン + 既知メンバー判定に加え、
      // INBOUND_EMAIL_AUTH=enforce のときは上流で SPF/DKIM/DMARC の明示 fail を隔離済み
      // (From 詐称の主要経路はそこで遮断される)。
      if (!senderIsAgent && ticket.creatorId !== sender.id) {
        console.warn(
          '[POST /api/inbound/email] quarantined: sender not allowed to append to thread',
        );
        await recordQuarantine(tenant.id, 'thread_forbidden', email);
        return NextResponse.json({ status: 'quarantined' }, { status: 202 });
      }
      // コメント通知の送信先を決める (Web フォーム経由コメントと共通ロジック)
      const recipientIds = await resolveCommentRecipients(
        ticket,
        sender.id,
        senderIsAgent,
        tenant.id,
      );
      // 通知メッセージ (Web フォーム経由コメントと同じ文言に揃える)
      const message = `チケット「${ticket.title}」に新しいコメントが追加されました`;

      // 監査で発見したギャップ対応: チケット当たりの添付総数上限を超えないか確認する。
      // メールスレッド継続は同じチケットへの追記を何度でも繰り返せるため、テナント累計サイズ上限
      // だけでは「1 件のチケットに無制限に添付が積み上がる」ことを防げない。Webhook はユーザーへ
      // 即時フィードバックする画面が無いため、上限超過時は失敗させず添付なしで取り込みを継続する
      // (このファイル内の累計サイズ上限チェックと同じ lenient な方針)。
      if (validatedAttachments.length > 0) {
        const ticketQuotaCheck = await checkTicketAttachmentQuota(
          repos,
          ticket.id,
          tenant.id,
          validatedAttachments.length,
        );
        if (!ticketQuotaCheck.ok) {
          console.warn(
            '[POST /api/inbound/email] attachments exceed per-ticket limit, continuing without them',
            { reason: ticketQuotaCheck.message },
          );
          validatedAttachments = [];
        }
      }

      // フォローアップ (2026-07-13): 添付ファイルのストレージ書き込みはトランザクション外の
      // 副作用のため、失敗時に後始末できるよう書き込み済みキーを蓄えておく
      // (POST /api/tickets/[id]/comments と同じ方針)
      const writtenKeys: string[] = [];
      // コメント追記 + 添付メタ INSERT + Message-ID 登録をトランザクションで行う。
      // 通知は「最善努力 (best-effort)」なので、トランザクション外で処理する。
      // 通知作成の失敗でコメント本体がロールバックされるのは本末転倒なためここで分離する (§9 fail-safe)。
      try {
        await uow.run(async (r) => {
          // 受信メール本文を既存チケットへのコメントとして追記する
          const comment = await r.comments.create({
            ticketId: ticket.id, // 紐づく既存チケット
            authorId: sender.id, // 追記者 = 送信者 (既知メンバー)
            body: email.body, // メール本文
            tenantId: tenant.id, // 親チケットのテナント一致を Adapter が検証する
          });
          // SLA: エージェントからのメール返信も初回応答として記録する (comments/route.ts と同じ扱い)。
          // ここを漏らすと、メール経由で最初に返信したチケットが SLA 上「未応答」のまま扱われ、
          // 品質メトリクス (平均初回応答時間) からも永久に除外されてしまう。
          // 依頼者自身の返信は「応答」ではないため対象外。既に記録済みなら上書きしない
          // (2 回目以降のエージェント返信で初回応答日時が後ろにズレるのを防ぐ)。
          if (senderIsAgent && !ticket.firstRespondedAt) {
            await r.tickets.markFirstResponded(ticket.id, now, tenant.id);
          }
          // フォローアップ (2026-07-13): 検証済み添付ファイルをこのコメントに紐づけて保存する
          if (validatedAttachments.length > 0) {
            await persistAttachments(
              r,
              validatedAttachments,
              ticket.id,
              comment.id, // コメントへの添付として記録する
              sender.id,
              tenant.id,
              writtenKeys,
            );
          }
          // この受信メール自身の Message-ID も対応表へ登録する (返信の連鎖を辿れるように)
          if (email.messageId) {
            await r.emailThreads.register({
              messageId: email.messageId,
              ticketId: ticket.id,
              tenantId: tenant.id,
            });
          }
        });
      } catch (err) {
        // DB は自動ロールバック済。ストレージに書き込んだファイルを best-effort で削除する
        await cleanupWrittenAttachments(writtenKeys, '[POST /api/inbound/email]');
        // 元のエラーをサーバログに残して 500 を返す (プロバイダは再送する)
        console.error('[POST /api/inbound/email] thread comment save failed', err);
        return NextResponse.json({ error: 'コメントの保存に失敗しました' }, { status: 500 });
      }
      // トランザクション完了後にベストエフォートで通知を作成する。
      // 失敗してもコメント自体は既にコミット済みなので、ログだけ残して続行する。
      // allSettled を使い 1 件の失敗で他の受信者への通知が止まらないようにする。
      if (recipientIds.length > 0) {
        // 各受信者へ「コメントが追加された」旨の通知を作成する (部分失敗を許容)
        const notifyResults = await Promise.allSettled(
          recipientIds.map((id) =>
            repos.notifications.create({
              userId: id,
              type: 'commented',
              message,
              ticketId: ticket.id,
              tenantId: tenant.id,
            }),
          ),
        );
        // 通知作成に成功した受信者だけを SSE 配信対象にする (失敗分は DB レコードが無いためスキップ)
        const succeededIds = recipientIds.filter(
          (_, i) => notifyResults[i]?.status === 'fulfilled',
        );
        const failedCount = recipientIds.length - succeededIds.length;
        if (failedCount > 0) {
          // 失敗件数だけログに残す (受信者 ID は個人情報のため省略)
          console.warn(
            `[POST /api/inbound/email] ${failedCount} notification(s) failed to create for ticket`,
            ticket.id,
          );
        }
        // 通知作成に成功した受信者にだけ未読件数を SSE で即時配信する
        if (succeededIds.length > 0) {
          await broadcastUnreadCountToMany(succeededIds, tenant.id).catch((err) => {
            // SSE 配信失敗はバッジ更新が遅れるだけ。ログのみ残して続行する
            console.warn('[POST /api/inbound/email] failed to broadcast unread count', err);
          });
        }
      }
      // 追記したチケット詳細ページのキャッシュを無効化して再描画させる
      revalidatePath(`/tickets/${ticket.id}`);
      // スレッド追記として 200 を返す (新規起票ではないことを threaded フラグで示す)
      return NextResponse.json({ ticketId: ticket.id, threaded: true }, { status: 200 });
    }
    // 参照先チケットが見つからない (削除済み等) 場合は、下の新規起票へフォールスルーする
    console.warn('[POST /api/inbound/email] referenced ticket not found; creating a new one');
  }

  // Phase 4 課金: 月間チケット上限チェック (Web フォーム・CSV インポートと共有)。
  // tenant-plan.ts のコメントで「全ての起票入口で共有する」と明記されているにもかかわらず、
  // メール取り込みだけこのチェックを呼んでいなかった。現状メール取り込みが使えるプラン
  // (Standard 以上) は月間上限が無制限のため実害は無いが、将来 Standard に有限上限が付いた
  // 瞬間にこの入口だけ無制限の抜け道になる SSOT 違反を防ぐため、他入口と揃えておく。
  // 上限到達時は未知送信者と同じ「隔離 202」にして、プロバイダの再送ループを避ける。
  const quota = await getMonthlyTicketQuota(tenant.id, effectivePlan);
  if (quota.limited && quota.remaining <= 0) {
    console.warn('[POST /api/inbound/email] quarantined: monthly ticket quota reached', {
      plan: effectivePlan,
    });
    await recordQuarantine(tenant.id, 'quota_exceeded', email);
    return NextResponse.json({ status: 'quarantined' }, { status: 202 });
  }

  // 起票時刻 (SLA 期限の計算基準)
  const now = new Date();
  // 初期ステータスは Web フォーム起票と同じ共通ルールで決める (Lite='Open' / Pro=DB既定 New)
  const initialStatus = initialStatusForMode(tenant.mode);
  // メールには期限指定が無いため、Web フォーム起票と同じく優先度 Medium ベースで解決期限を算出する
  const resolutionDueAt = calculateResolutionDueAt('Medium', now);
  // 初回応答期限も同じく優先度 Medium ベースで自動算出する
  const firstResponseDueAt = calculateFirstResponseDueAt('Medium', now);

  // フォローアップ (2026-07-13): 添付ファイルのストレージ書き込みはトランザクション外の副作用の
  // ため、失敗時に後始末できるよう書き込み済みキーを蓄えておく (POST /api/tickets と同じ方針)
  const writtenKeys: string[] = [];
  let ticketId: string;
  let alreadyExisted: boolean;
  try {
    // 受信メールを 1 件の問い合わせとして作成する (起票 + 添付メタ INSERT + 対応表登録を
    // onCreated フック経由で同一トランザクション内で原子的に行う)
    const created = await createTicketIdempotent(
      emailMessageIdempotencyOps,
      email.messageId, // 冪等化キー (無い場合は null)
      tenant.id,
      {
        title: email.subject, // 件名 (空メールは既定タイトルに正規化済み)
        body: email.body, // 本文テキスト
        priority: 'Medium', // メール取り込みは優先度を Medium 固定 (Lite の既定と揃える)
        categoryId: null, // メール取り込みではカテゴリ未分類
        creatorId: sender.id, // 起票者は送信者本人 (既知メンバー)
        tenantId: tenant.id, // 取り込み先テナント
        status: initialStatus, // Lite は 'Open'、Pro は undefined (既定 New)
        resolutionDueAt, // 解決期限 (優先度ベース)
        firstResponseDueAt, // 初回応答期限 (優先度ベース)
      },
      {
        // フォローアップ (2026-07-13): 検証済み添付ファイルをこの新規チケットに紐づけて保存する
        onCreated:
          validatedAttachments.length > 0
            ? (tx, newTicketId) =>
                persistAttachments(
                  tx,
                  validatedAttachments,
                  newTicketId,
                  null, // 新規起票への添付 (コメントには紐づかない)
                  sender.id,
                  tenant.id,
                  writtenKeys,
                )
            : undefined,
      },
    );
    ticketId = created.id;
    alreadyExisted = created.alreadyExisted;
  } catch (err) {
    // /code-review ultra 指摘対応 (2026-07-13): 冪等化キーの有無に関わらず、DB は自動ロールバック
    // 済み (createTicketIdempotent がキー無し経路もトランザクション化したため、チケット行だけが
    // 添付無しで残ることは無い)。ストレージへの書き込みだけはトランザクション外の副作用のため、
    // 書き込み済みキーを個別に best-effort で削除する
    await cleanupWrittenAttachments(writtenKeys, '[POST /api/inbound/email]');
    console.error('[POST /api/inbound/email] ticket creation failed', err);
    return NextResponse.json({ error: '問い合わせの作成に失敗しました' }, { status: 500 });
  }

  if (alreadyExisted) {
    // 書き込み競合により、別リクエストが既に起票・受領返信済みと判明したケース。
    // 二重にチケットや受領メールを作らないよう、ここでは何もせず既存チケット ID を返す
    console.info('[POST /api/inbound/email] resolved write conflict as duplicate', ticketId);
    // /code-review ultra 指摘対応 (2026-07-13): このリクエスト自身の (敗れた) トランザクション内で
    // onCreated が添付ファイルを既にストレージへ書き込んでいた場合、DB 側はロールバックされても
    // ストレージの書き込みはトランザクション外の副作用のため残ってしまう。writtenKeys にはこの
    // リクエスト自身が書き込んだキーだけが積まれる (勝者側の書き込みとは無関係) ため、常に
    // 安全にクリーンアップできる (何も書いていなければ空配列で no-op)
    if (writtenKeys.length > 0) {
      await cleanupWrittenAttachments(writtenKeys, '[POST /api/inbound/email]');
    }
    return NextResponse.json({ status: 'duplicate', ticketId }, { status: 200 });
  }

  // 新規起票をテナント内の全エージェントへアプリ内通知する (LINE 取り込みと共有ヘルパーを使う)。
  // Slack/Teams/Chatwork 通知は任意設定のオプトイン機能のため、未設定のテナントではメール起票に
  // エージェントが誰も気づけない非対称な穴があった (LINE/CSV は既に対応済み)。
  // 失敗してもチケット起票自体は確定済みのため、ログのみ残して続行する (§9 fail-safe)。
  try {
    // テナント内のエージェント/管理者一覧を取得する (LINE 取り込みと同じヘルパー)
    const agents = await repos.users.listAgents(tenant.id);
    // 通知対象: 送信者自身がエージェントなら本人以外、依頼者からの起票なら全エージェントへ通知する
    const notifyTargets = isAgent(sender.role)
      ? agents.filter((a) => a.id !== sender.id) // エージェント自身の起票は本人以外へ通知
      : agents; // 依頼者からの起票は全エージェントへ通知
    // 通知作成・SSE 配信は LINE 取り込みと共有のヘルパーに委譲する (CLAUDE.md §6 DRY)
    await notifyAgentsOfNewTicket({
      tenantId: tenant.id, // テナントスコープ
      ticketId, // 紐付けチケット
      message: `メールから新しい問い合わせが届きました：${email.subject}`, // 通知文言
      targets: notifyTargets, // 通知対象エージェント一覧
      logPrefix: '[POST /api/inbound/email]', // ログの識別子
    });
  } catch (notifyErr) {
    // 通知失敗はログのみ (チケット起票は完了しているため応答は成功扱いのまま)
    console.warn(
      '[POST /api/inbound/email] failed to notify agents for new ticket',
      ticketId,
      notifyErr,
    );
  }

  // Phase 4: 新規起票を Slack/Teams/Chatwork へ通知する (Web フォーム・LINE・CSV と同じ経路)。
  // メール取り込みは担当者が画面を開かなくても起票された事実に気づけることが重要なため、
  // 受領自動返信と同様にベストエフォートで送る (失敗してもチケット作成のレスポンスには影響しない)
  await notifyNewTicketOutbound(tenant.id, {
    id: ticketId,
    title: email.subject,
    priority: 'Medium',
  });

  // 初回メール起票の受領自動返信 (メンバー改善 #1): 送信元へ「受け付けました」を 1 通返す。
  // Web フォーム起票は送信後すぐ画面に出るが、メール起票は受領確認が無いと「届いたか不明」になる穴を埋める。
  // 自動配信メール (Auto-Submitted / Precedence: bulk 等) には返信しない (メールループ防止 §9 fail-safe)。
  // スレッド追記・重複再送のパスは上で return 済みなので、ここに来るのは「新規起票」だけ。
  if (!isAutomatedEmail(fields)) {
    await sendReceivedAck({
      to: sender.email,
      ticketId,
      ticketTitle: email.subject,
      tenantId: tenant.id,
    });
  }

  // 作成された問い合わせ ID を 201 で返す (プロバイダは本文を使わないが疎通確認に役立つ)
  return NextResponse.json({ ticketId }, { status: 201 });
}
