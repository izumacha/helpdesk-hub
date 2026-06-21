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
// 共有シークレットの定数時間比較に使う (Node ランタイム前提のルート)
import { timingSafeEqual } from 'node:crypto';
// ページキャッシュ無効化 (スレッド継続でコメント追記したチケット詳細を再描画させる)
import { revalidatePath } from 'next/cache';
// データ層 (テナント / ユーザー / チケットのリポジトリ束 + トランザクション境界)
import { repos, uow } from '@/data';
// 新規起票時の初期ステータスを mode から決める共通ルール (Web フォーム起票と単一の源を共有)
import { initialStatusForMode } from '@/domain/ticket-status';
// コメント通知の宛先決定 (Web フォーム経由コメントと共有するヘルパー)
import { resolveCommentRecipients } from '@/lib/comment-recipients';
// 未読件数を SSE で即時配信するヘルパー (コメント追記時の通知扇形)
import { broadcastUnreadCountToMany } from '@/features/notifications/notify';
// 受信メールの正規化ヘルパー (純粋関数) と生ヘッダ読み取り
import { parseInboundEmail, readRawHeader } from '@/lib/inbound-email';
// エージェント権限判定 (スレッド追記の RBAC に使用)
import { isAgent } from '@/lib/role';
// 公開エンドポイントの流量制限 (§9: DoS / リソース枯渇防止)
import { enforceRateLimit, RateLimitError } from '@/lib/rate-limit';
// 優先度から解決期限を計算する SLA ヘルパー (Web フォーム起票と同じ既定値に揃える)
import { calculateResolutionDueAt } from '@/lib/sla';

// このルートは Node ランタイムで動かす (node:crypto / Prisma を使うため Edge では動かない)
export const runtime = 'nodejs';

// 受信ボディの最大バイト数 (一般的なメール送信上限の 25MB)。これを超える Content-Length は
// パース前に拒否し、巨大ボディの全読み込みによるメモリ枯渇 (§9) を防ぐ
const MAX_INBOUND_BODY_BYTES = 25 * 1024 * 1024;
// テナント単位の取り込み流量上限。共有シークレット漏洩時でもテナントあたりの起票を抑える。
// (キーはテナント ID なのでバケット数は実在テナント数で頭打ち = メモリも有界)
const INBOUND_RATE_LIMIT = { limit: 120, windowMs: 60_000 } as const;

// 2 つのシークレット文字列を定数時間で比較する (タイミング攻撃対策)。
// 長さが違う場合は早期 false (情報量は長さのみで実用上問題なし)。
function secretsMatch(provided: string, expected: string): boolean {
  // バイト列化して長さ比較 (長さが違えば timingSafeEqual が例外を投げるため先に弾く)
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  // 同じ長さなら定数時間比較する
  return timingSafeEqual(a, b);
}

// リクエストから提示されたシークレットを取り出す (ヘッダ優先、無ければクエリ)。
// プロバイダによって署名手段が無いものがあるため、設定で渡せる共有シークレット方式を採る。
function readProvidedSecret(req: Request, url: URL): string | null {
  // 専用ヘッダを最優先で見る
  const header = req.headers.get('x-inbound-secret');
  if (header) return header;
  // 次にクエリパラメータ ?secret= を見る (Webhook URL にシークレットを埋め込む運用向け)
  return url.searchParams.get('secret');
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
    // ボディを FormData にパースする
    const form = await req.formData();
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
    // 宛先 (ルーティング): envelope の RCPT を優先する (ヘッダ To より実配送先として確実)。
    // 送信者 (本人特定): ヘッダ From を優先する (人間が送った差出人。envelope from=MAIL FROM は
    // 戻り先で本人性が弱い)。いずれも DKIM/SPF 検証は将来課題で、現状は既知メンバー判定で守る。
    return {
      to: envTo ?? str(form.get('to')),
      from: str(form.get('from')) ?? envFrom,
      subject: str(form.get('subject')),
      text: str(form.get('text')),
      // Message-ID 系は個別フィールド優先、無ければ生ヘッダから読む
      messageId: str(form.get('message-id')) ?? readRawHeader(rawHeaders, 'Message-ID'),
      inReplyTo: str(form.get('in-reply-to')) ?? readRawHeader(rawHeaders, 'In-Reply-To'),
      references: str(form.get('references')) ?? readRawHeader(rawHeaders, 'References'),
    };
  }
  // それ以外は JSON ボディとして読む (テスト・自前連携向け)
  const body = (await req.json()) as Record<string, unknown>;
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
  };
}

// POST /api/inbound/email : 受信メールを 1 件の問い合わせに変換する
export async function POST(req: Request) {
  // URL を解析 (クエリのシークレット取得に使う)
  const url = new URL(req.url);

  // 共有シークレットを環境変数から読む。未設定なら fail-closed (無防備な取り込み口を開けない)
  const expectedSecret = process.env.INBOUND_EMAIL_SECRET?.trim();
  if (!expectedSecret) {
    // 設定漏れはサーバログにエラーとして残し、外部には詳細を出さない 500 を返す
    console.error('[POST /api/inbound/email] INBOUND_EMAIL_SECRET is not configured');
    return NextResponse.json({ error: 'メール取り込みは利用できません' }, { status: 500 });
  }

  // 提示されたシークレットを取り出して定数時間比較する
  const provided = readProvidedSecret(req, url);
  if (!provided || !secretsMatch(provided, expectedSecret)) {
    // 不一致は 401 (なりすまし POST を拒否)
    return NextResponse.json({ error: '認証に失敗しました' }, { status: 401 });
  }

  // Content-Length が上限超過なら本体を読む前に 413 で弾く (巨大ボディのメモリ枯渇防止 §9)。
  // ヘッダが無い (chunked) 場合まではここでは防げないため、後段の長さ上限と併用する
  const contentLength = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_INBOUND_BODY_BYTES) {
    return NextResponse.json({ error: 'メールが大きすぎます' }, { status: 413 });
  }

  // 受信メールのフィールドを取り出す (JSON / multipart 両対応)
  let fields: InboundFields;
  try {
    fields = await readInboundFields(req);
  } catch (err) {
    // ボディのパース失敗は 400 (握り潰さずログに残す)
    console.error('[POST /api/inbound/email] failed to read request body', err);
    return NextResponse.json({ error: 'リクエストの形式が正しくありません' }, { status: 400 });
  }

  // 宛先ドメインの検証用 (任意設定)。設定されていれば宛先ドメイン一致を必須にする
  const expectedDomain = process.env.INBOUND_EMAIL_DOMAIN?.trim() || null;
  // フィールドを正規化する (宛先トークン・送信者・件名・本文)
  const parsed = parseInboundEmail(fields, { expectedDomain });
  // 必須情報が欠けていれば 422 (起票できない理由をログに残す)
  if (!parsed.ok) {
    console.warn('[POST /api/inbound/email] unprocessable email', parsed.reason);
    return NextResponse.json({ error: parsed.reason }, { status: 422 });
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
  // 超過時は 429 + Retry-After で返し、プロバイダの後刻リトライに委ねる
  try {
    enforceRateLimit(`inbound-email:${tenant.id}`, INBOUND_RATE_LIMIT);
  } catch (err) {
    // 流量超過専用エラーだけを 429 にマップ。それ以外は想定外なので上位へ投げる
    if (err instanceof RateLimitError) {
      return NextResponse.json(
        { error: '取り込みが混み合っています' },
        { status: 429, headers: { 'Retry-After': String(err.retryAfterSec) } },
      );
    }
    throw err;
  }

  // 送信者がそのテナントの既知メンバーかを確認する。
  // findByEmail はテナント横断のため、必ず tenantId 一致まで検査してクロステナント起票を防ぐ。
  const sender = await repos.users.findByEmail(email.senderAddress);
  if (!sender || sender.tenantId !== tenant.id) {
    // 未知送信者は隔離扱い: 起票せず 202 を返す (プロバイダの再送ループを避けつつ無視する)
    console.warn('[POST /api/inbound/email] quarantined: unknown sender for tenant');
    return NextResponse.json({ status: 'quarantined' }, { status: 202 });
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
      // 追記の権限: エージェント、または自分が起票したチケットのみ (第三者メンバーの混線/露出を防ぐ)。
      // 権限の無いメンバーは隔離扱い (202) にして無視する。
      // セキュリティ注意 (§9 / §8 リスク表): 送信者の本人性はヘッダ From + 既知メンバー判定に依存し、
      // DKIM/SPF 検証は未実装 (既存メール取り込みと同じ前提 = 将来課題)。エージェントの From を詐称した
      // なりすまし POST は、共有シークレット (INBOUND_EMAIL_SECRET) と取り込みトークンの両方を要するため
      // 信頼境界はプロバイダ側にあるが、本人性を強める SPF/DKIM 検証を後続で入れること。
      if (!senderIsAgent && ticket.creatorId !== sender.id) {
        console.warn(
          '[POST /api/inbound/email] quarantined: sender not allowed to append to thread',
        );
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
      // コメント追記 + Message-ID 登録 + 通知作成を 1 トランザクションで行う (中途半端な状態を残さない)
      await uow.run(async (r) => {
        // 受信メール本文を既存チケットへのコメントとして追記する
        await r.comments.create({
          ticketId: ticket.id, // 紐づく既存チケット
          authorId: sender.id, // 追記者 = 送信者 (既知メンバー)
          body: email.body, // メール本文
          tenantId: tenant.id, // 親チケットのテナント一致を Adapter が検証する
        });
        // この受信メール自身の Message-ID も対応表へ登録する (返信の連鎖を辿れるように)
        if (email.messageId) {
          await r.emailThreads.register({
            messageId: email.messageId,
            ticketId: ticket.id,
            tenantId: tenant.id,
          });
        }
        // 通知対象へ「コメントが追加された」旨を一斉送付する
        await Promise.all(
          recipientIds.map((id) =>
            r.notifications.create({
              userId: id,
              type: 'commented',
              message,
              ticketId: ticket.id,
              tenantId: tenant.id,
            }),
          ),
        );
      });
      // 通知対象が居れば未読件数を SSE で即時配信する
      if (recipientIds.length > 0) await broadcastUnreadCountToMany(recipientIds, tenant.id);
      // 追記したチケット詳細ページのキャッシュを無効化して再描画させる
      revalidatePath(`/tickets/${ticket.id}`);
      // スレッド追記として 200 を返す (新規起票ではないことを threaded フラグで示す)
      return NextResponse.json({ ticketId: ticket.id, threaded: true }, { status: 200 });
    }
    // 参照先チケットが見つからない (削除済み等) 場合は、下の新規起票へフォールスルーする
    console.warn('[POST /api/inbound/email] referenced ticket not found; creating a new one');
  }

  // 起票時刻 (SLA 期限の計算基準)
  const now = new Date();
  // 初期ステータスは Web フォーム起票と同じ共通ルールで決める (Lite='Open' / Pro=DB既定 New)
  const initialStatus = initialStatusForMode(tenant.mode);
  // メールには期限指定が無いため、Web フォーム起票と同じく優先度 Medium ベースで解決期限を算出する
  const resolutionDueAt = calculateResolutionDueAt('Medium', now);

  // 受信メールを 1 件の問い合わせとして作成する
  const ticket = await repos.tickets.create({
    title: email.subject, // 件名 (空メールは既定タイトルに正規化済み)
    body: email.body, // 本文テキスト
    priority: 'Medium', // メール取り込みは優先度を Medium 固定 (Lite の既定と揃える)
    categoryId: null, // メール取り込みではカテゴリ未分類
    creatorId: sender.id, // 起票者は送信者本人 (既知メンバー)
    tenantId: tenant.id, // 取り込み先テナント
    status: initialStatus, // Lite は 'Open'、Pro は undefined (既定 New)
    resolutionDueAt, // 解決期限 (優先度ベース)
  });

  // この受信メールの Message-ID を対応表へ登録する (後続の返信をこのチケットへ紐付けるため)。
  // ベストエフォート: 登録失敗で 500 を返すと再送 → 二重起票になりかねないので、握ってログに残す。
  if (email.messageId) {
    try {
      await repos.emailThreads.register({
        messageId: email.messageId,
        ticketId: ticket.id,
        tenantId: tenant.id,
      });
    } catch (err) {
      console.warn('[POST /api/inbound/email] failed to register inbound message id', err);
    }
  }

  // 作成された問い合わせ ID を 201 で返す (プロバイダは本文を使わないが疎通確認に役立つ)
  return NextResponse.json({ ticketId: ticket.id }, { status: 201 });
}
