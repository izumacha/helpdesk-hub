/**
 * LINE 公式アカウント Webhook (Phase 2 β / docs/smb-dx-pivot-plan.md §4 / §5.3)
 *
 * LINE 公式アカウントに送られたテキストメッセージを受信し、テナントの問い合わせ (Ticket) として
 * 取り込む。複数イベントを 1 リクエストで受け取ることがあるため、テキストメッセージ以外は無視して
 * 全イベントを処理してから 200 を返す (LINE は 200 未受信で 5 分以内に再送するため必ず 200 を返す)。
 *
 * β 制約 (本計画書 §8 リスク表):
 *  - 1 テナント / 1 LINE チャネル構成を env var で決め打ち (マルチチャネルは将来課題)。
 *    LINE_CHANNEL_SECRET: Webhook 署名の検証に使うチャネルシークレット
 *    LINE_TARGET_TENANT_ID: メッセージを受け付けるテナント ID
 *  - LINE ユーザーとテナントメンバーの紐付けは未実装。テナントの最初の管理者をプロキシ起票者とする。
 *    チケット本文に LINE ユーザー ID を記録するため、担当者が手動で連絡できる。
 *  - DKIM/SPF 相当の送信者検証は LINE 署名のみ (LINE サーバからのみ受信する保証は署名が担う)。
 *
 * セキュリティ要点 (§9):
 *  - X-Line-Signature ヘッダの HMAC-SHA256 を定数時間比較で検証する (LINE Docs 準拠)。
 *  - シークレット・テナント ID 未設定は fail-closed (500 で取り込み口を閉じる)。
 *  - テナント単位のレート制限でバーストに備える。
 */

// JSON レスポンスヘルパー
import { NextResponse } from 'next/server';
// 署名検証に使う HMAC ユーティリティ (Node ランタイム前提)
import { createHmac, timingSafeEqual } from 'node:crypto';
// データ層の Composition Root (テナント / ユーザー / チケットのリポジトリ束)
import { repos } from '@/data';
// 新規起票時の初期ステータスを mode から決める共通ルール (Web フォーム起票と単一の源を共有)
import { initialStatusForMode } from '@/domain/ticket-status';
// 公開エンドポイントの流量制限 (§9: DoS / リソース枯渇防止)
import { enforceRateLimit, RateLimitError } from '@/lib/rate-limit';
// 優先度から解決期限を計算する SLA ヘルパー (他の取り込みチャネルと同じ既定値に揃える)
import { calculateResolutionDueAt } from '@/lib/sla';

// このルートは Node ランタイムで動かす (node:crypto / Prisma を使うため Edge では動かない)
export const runtime = 'nodejs';

// テナント単位の取り込み流量上限 (シークレット漏洩時のスパムを抑える)
const LINE_RATE_LIMIT = { limit: 120, windowMs: 60_000 } as const;

// チケットタイトルとして使うテキストの最大文字数 (長すぎる場合は末尾を省略する)
const MAX_TITLE_LENGTH = 100;

// LINE Webhook が送ってくるテキストメッセージの型
interface LineTextMessage {
  type: 'text'; // テキストメッセージであることを示す種別
  id: string; // メッセージ ID
  text: string; // メッセージ本文
}

// LINE Webhook のイベント 1 件分の型 (テキストメッセージイベントに絞って定義)
interface LineMessageEvent {
  type: 'message'; // メッセージイベント
  replyToken: string; // 返信用トークン (β では使わない)
  source: {
    type: 'user' | 'group' | 'room'; // 送信元の種別
    userId?: string; // ユーザー ID (user タイプの場合のみ存在)
    groupId?: string; // グループ ID (group タイプの場合のみ存在)
    roomId?: string; // ルーム ID (room タイプの場合のみ存在)
  };
  message: LineTextMessage | { type: string }; // メッセージの中身 (テキスト以外は type だけ参照)
  timestamp: number; // Unix ミリ秒のイベント発生時刻
}

// LINE が POST してくる Webhook ボディの型
interface LineWebhookBody {
  destination: string; // LINE チャネルのユーザー ID (受信先の特定に使えるが β では env var を使う)
  events: LineMessageEvent[]; // 1 リクエストに複数イベントが含まれることがある
}

// LINE Webhook の署名を検証する関数 (LINE Developers ドキュメント準拠)
// X-Line-Signature = Base64(HMAC-SHA256(requestBody, channelSecret))
// タイミング攻撃対策として定数時間比較を使う
function verifyLineSignature(rawBody: string, signature: string, channelSecret: string): boolean {
  // チャネルシークレットでリクエストボディを HMAC-SHA256 で署名する
  const hmac = createHmac('sha256', channelSecret);
  // ボディは UTF-8 文字列として署名対象にする (LINE は文字コードを UTF-8 前提にしている)
  hmac.update(rawBody, 'utf8');
  // 期待される署名を Base64 で得る
  const expected = hmac.digest('base64');

  // 定数時間比較のために Buffer 化する (長さが違う場合は早期 false で返す)
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  // 長さが違えば false (timingSafeEqual は同一長さを前提とするため先に弾く)
  if (a.length !== b.length) return false;
  // 同一長さなら定数時間比較して HMAC 一致を判定する
  return timingSafeEqual(a, b);
}

// POST /api/inbound/line : LINE Webhook を受信してチケットを作成する
export async function POST(req: Request) {
  // LINE チャネルシークレットを環境変数から取得する (未設定なら fail-closed)
  const channelSecret = process.env.LINE_CHANNEL_SECRET?.trim();
  if (!channelSecret) {
    // 設定漏れはサーバーログに残し、外部には詳細を出さない 500 を返す (§9 fail-closed)
    console.error('[POST /api/inbound/line] LINE_CHANNEL_SECRET is not configured');
    return NextResponse.json({ error: 'LINE 連携は利用できません' }, { status: 500 });
  }

  // 取り込み先テナント ID を環境変数から取得する (未設定なら fail-closed)
  const targetTenantId = process.env.LINE_TARGET_TENANT_ID?.trim();
  if (!targetTenantId) {
    // テナント ID が設定されていない場合はメッセージを起票する先がないため拒否する
    console.error('[POST /api/inbound/line] LINE_TARGET_TENANT_ID is not configured');
    return NextResponse.json({ error: 'LINE 連携の送信先が設定されていません' }, { status: 500 });
  }

  // ボディを文字列として読み込む (署名検証は JSON.parse 前の生テキストに対して行う必要がある)
  const rawBody = await req.text();

  // X-Line-Signature ヘッダを取得する。trim() でプロキシが付加した空白を除去してから比較する
  // (末尾に \n 等が付くと Buffer の長さが変わり定数時間比較が失敗して正規リクエストを弾く)
  const signature = req.headers.get('x-line-signature')?.trim() ?? null;
  if (!signature) {
    // 署名ヘッダが無いリクエストは LINE サーバからのものではないと判断して拒否する
    return NextResponse.json({ error: '署名ヘッダがありません' }, { status: 401 });
  }

  // 署名を検証する (不正なら 401)
  if (!verifyLineSignature(rawBody, signature, channelSecret)) {
    // 署名不一致は LINE サーバからのものではないため拒否する (なりすまし POST の防止)
    return NextResponse.json({ error: '署名の検証に失敗しました' }, { status: 401 });
  }

  // 検証済みの生ボディを JSON としてパースする
  let body: LineWebhookBody;
  try {
    // 署名検証済みなので JSON として安全にパースできる
    body = JSON.parse(rawBody) as LineWebhookBody;
  } catch (err) {
    // パース失敗は 400 (内容を外部に出さずログに記録する)
    console.error('[POST /api/inbound/line] failed to parse webhook body', err);
    return NextResponse.json({ error: 'リクエストの形式が正しくありません' }, { status: 400 });
  }

  // テナント単位のレート制限を適用する (シークレット漏洩時のバーストを防ぐ)
  try {
    // 同期の流量制限チェック (超過時は RateLimitError を throw する)
    enforceRateLimit(`inbound-line:${targetTenantId}`, LINE_RATE_LIMIT);
  } catch (err) {
    // 流量超過専用エラーだけを 429 にマップ。それ以外は想定外なので上位へ再 throw する
    if (err instanceof RateLimitError) {
      return NextResponse.json(
        { error: '取り込みが混み合っています' },
        { status: 429, headers: { 'Retry-After': String(err.retryAfterSec) } },
      );
    }
    throw err;
  }

  // 取り込み先テナントを ID で引く
  const tenant = await repos.tenants.findById(targetTenantId);
  if (!tenant) {
    // env var に設定したテナント ID が存在しない場合はサーバー設定エラーとして 404 を返す
    console.error('[POST /api/inbound/line] target tenant not found:', targetTenantId);
    return NextResponse.json({ error: '送信先テナントが見つかりません' }, { status: 404 });
  }

  // β: LINE ユーザーとテナントメンバーの紐付けが未実装のため、テナントの管理者をプロキシ起票者とする。
  // テナントの agent/admin 一覧から先頭のユーザーをプロキシ起票者として選ぶ
  const agents = await repos.users.listAgents(targetTenantId);
  if (agents.length === 0) {
    // エージェントがいないテナントは起票者を決められないため処理できない
    console.warn('[POST /api/inbound/line] no agents found for tenant:', targetTenantId);
    return NextResponse.json({ error: 'テナントに担当者が設定されていません' }, { status: 422 });
  }
  // テナントの最初のエージェント/管理者をプロキシ起票者とする
  const proxyCreator = agents[0]!;

  // 起票時刻 (SLA 期限の計算基準)
  const now = new Date();
  // 初期ステータスは Web フォーム起票と同じ共通ルールで決める (Lite='Open' / Pro のデフォルト='New')
  const initialStatus = initialStatusForMode(tenant.mode);
  // メッセージには期限指定が無いため優先度 Medium ベースで解決期限を算出する
  const resolutionDueAt = calculateResolutionDueAt('Medium', now);

  // 1 リクエストに含まれる複数イベントを順に処理してチケットを起票する
  const ticketIds: string[] = [];
  for (const event of body.events) {
    // メッセージイベント以外 (follow / unfollow / postback 等) はスキップする
    if (event.type !== 'message') continue;
    // テキストメッセージ以外 (スタンプ / 画像 / 動画 等) はスキップする
    if (event.message.type !== 'text') continue;

    // テキストメッセージとして型を確定させる
    const textMessage = event.message as LineTextMessage;
    // LINE ユーザー ID を取得する (user タイプ以外は '不明' とする)
    const lineUserId = event.source.userId ?? '不明';

    // 空白のみのメッセージはタイトルが空文字列になるため起票対象外としてスキップする
    // (LINE は空文字メッセージを送信できる場合があり、Zod min(1) を持たないこのパスでは別途ガードが必要)
    const trimmedText = textMessage.text.trim();
    if (!trimmedText) continue;

    // チケットタイトルはメッセージテキストの先頭 MAX_TITLE_LENGTH 文字にする
    const title =
      trimmedText.length > MAX_TITLE_LENGTH
        ? `${trimmedText.slice(0, MAX_TITLE_LENGTH)}…`
        : trimmedText;

    // チケット本文: LINE ユーザー ID と全メッセージテキストを含める (担当者が手動連絡できるよう)
    const ticketBody = `[LINE 経由の問い合わせ]\nLINE ユーザー ID: ${lineUserId}\n\n${textMessage.text}`;

    // 新規チケットを起票する (Web フォーム・メール取り込みと同じ PORT 経由)
    const ticket = await repos.tickets.create({
      title, // LINE メッセージから生成したタイトル
      body: ticketBody, // LINE ユーザー ID + 全文
      priority: 'Medium', // LINE 取り込みは優先度 Medium 固定 (他チャネルと揃える)
      categoryId: null, // カテゴリは未分類 (担当者が後で設定)
      creatorId: proxyCreator.id, // テナント管理者をプロキシ起票者とする (β 制約)
      tenantId: targetTenantId, // 取り込み先テナント
      status: initialStatus, // Lite は 'Open'、Pro は DB 既定 'New'
      resolutionDueAt, // 優先度 Medium ベースの解決期限
    });

    // 起票したチケット ID を記録する
    ticketIds.push(ticket.id);
  }

  // LINE サーバーはレスポンスを 30 秒以内に受信しないと再送するため、必ず 200 を返す
  return NextResponse.json({ ticketIds }, { status: 200 });
}
