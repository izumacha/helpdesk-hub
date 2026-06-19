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
// データ層 (テナント / ユーザー / チケットのリポジトリ束)
import { repos } from '@/data';
// 受信メールの正規化ヘルパー (純粋関数)
import { parseInboundEmail } from '@/lib/inbound-email';
// 優先度から解決期限を計算する SLA ヘルパー (Web フォーム起票と同じ既定値に揃える)
import { calculateResolutionDueAt } from '@/lib/sla';

// このルートは Node ランタイムで動かす (node:crypto / Prisma を使うため Edge では動かない)
export const runtime = 'nodejs';

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

// 受信メール 1 通分のフィールド (to / from / subject / text) を、JSON / multipart の
// どちらのボディからでも取り出して共通形に揃える。
async function readInboundFields(req: Request): Promise<{
  to?: string | null;
  from?: string | null;
  subject?: string | null;
  text?: string | null;
}> {
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
    // envelope 由来を優先しつつ、無ければヘッダ (to/from) で補完する
    return {
      to: envTo ?? str(form.get('to')),
      from: envFrom ?? str(form.get('from')),
      subject: str(form.get('subject')),
      text: str(form.get('text')),
    };
  }
  // それ以外は JSON ボディとして読む (テスト・自前連携向け)
  const body = (await req.json()) as Record<string, unknown>;
  // 文字列フィールドだけを取り出す小ヘルパー
  const pick = (k: string): string | null =>
    typeof body[k] === 'string' ? (body[k] as string) : null;
  return { to: pick('to'), from: pick('from'), subject: pick('subject'), text: pick('text') };
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

  // 受信メールのフィールドを取り出す (JSON / multipart 両対応)
  let fields: {
    to?: string | null;
    from?: string | null;
    subject?: string | null;
    text?: string | null;
  };
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

  // 送信者がそのテナントの既知メンバーかを確認する。
  // findByEmail はテナント横断のため、必ず tenantId 一致まで検査してクロステナント起票を防ぐ。
  const sender = await repos.users.findByEmail(email.senderAddress);
  if (!sender || sender.tenantId !== tenant.id) {
    // 未知送信者は隔離扱い: 起票せず 202 を返す (プロバイダの再送ループを避けつつ無視する)
    console.warn('[POST /api/inbound/email] quarantined: unknown sender for tenant');
    return NextResponse.json({ status: 'quarantined' }, { status: 202 });
  }

  // 起票時刻 (SLA 期限の計算基準)
  const now = new Date();
  // Lite モードでは 3 値の起点 'Open' (未対応) で起票し、Pro は DB 既定 (New) のままにする
  const initialStatus = tenant.mode === 'lite' ? ('Open' as const) : undefined;
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

  // 作成された問い合わせ ID を 201 で返す (プロバイダは本文を使わないが疎通確認に役立つ)
  return NextResponse.json({ ticketId: ticket.id }, { status: 201 });
}
