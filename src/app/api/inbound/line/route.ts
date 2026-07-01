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
 *  - LINE ユーザーとテナントメンバーの紐付け: メンバーが Web 設定画面で発行したワンタイムコードを
 *    LINE に送ると、その送信元 LINE ユーザー ID をメンバーへ紐付ける。紐付け済みなら起票者は本人になり
 *    自己解決 UI が開通する。未紐付けの LINE ユーザーは従来どおりテナント内担当者をプロキシ起票者とする
 *    (本文に LINE ユーザー ID を残すので担当者が手動連絡できる)。アウトバウンド LINE 返信は
 *    `src/lib/line-push.ts` (Messaging API push) で実装済み: 紐付け済みメンバーが起票したチケットに
 *    担当者が返信すると、その内容が LINE へ push される (`src/app/api/tickets/[id]/comments/route.ts`)。
 *    連携完了の確認は Web 設定画面の「連携済み」表示で行う。
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
// LINE メンバー紐付け: 受信テキストの正規化・コード形判定・ハッシュ化 (発行は Web 設定画面側)
// LINE ユーザー ID の正規形式 (line-push.ts と共有する単一の源)
import {
  hashLineLinkCode,
  LINE_USER_ID_PATTERN,
  looksLikeLineLinkCode,
  normalizeLineLinkCode,
} from '@/lib/line-link';
// 未読カウントを SSE で即時配信するヘルパー (新規起票後に担当者のバッジをリアルタイム更新する)
import { broadcastUnreadCountToMany } from '@/features/notifications/notify';
// LINE 連携機能のプランゲート (§6.1 料金プラン: Pro / Enterprise のみ利用可能)
import { isLineIntegrationAllowed } from '@/lib/plan-guard';

// このルートは Node ランタイムで動かす (node:crypto / Prisma を使うため Edge では動かない)
export const runtime = 'nodejs';

// テナント単位の取り込み流量上限 (シークレット漏洩時のスパムを抑える)
const LINE_RATE_LIMIT = { limit: 120, windowMs: 60_000 } as const;

// チケットタイトルとして使うテキストの最大文字数 (長すぎる場合は末尾を省略する)
const MAX_TITLE_LENGTH = 100;

// 1 リクエストに含まれるイベントの上限 (LINE の通常配信は数件程度だが、
// 署名付き細工リクエストで大量のイベントを送られると DB インサートが増幅するため上限を設ける)
const MAX_EVENTS_PER_REQUEST = 20;

// チケット本文として保存するテキストの最大文字数 (LINE のプラットフォーム上限は 5000 文字だが、
// サーバー側でも明示的に制限して DB の TEXT 型フィールドへの過大な書き込みを防ぐ)
const MAX_BODY_LENGTH = 10_000;

// リクエストボディの最大バイト数 (256KB)。LINE の Webhook ペイロードはテキストのみで小さいため、
// 巨大ボディはメモリ枯渇狙いの攻撃とみなして本体を読む前に 413 で弾く (§9 DoS 対策。
// メール取り込み側の MAX_INBOUND_BODY_BYTES と同じ「読む前に上限チェック」方針)
const MAX_REQUEST_BODY_BYTES = 256 * 1024;

// LINE Webhook が送ってくるテキストメッセージの型
interface LineTextMessage {
  type: 'text'; // テキストメッセージであることを示す種別
  id: string; // メッセージ ID
  text: string; // メッセージ本文
}

// LINE Webhook のイベント 1 件分の型。
// 署名検証済みでも JSON の構造は信用しないため (§9)、各フィールドは任意 (optional) として扱い、
// 実行時に存在チェックしてから参照する。follow / unfollow / postback 等の非メッセージイベントや、
// source / message を欠くイベントが届いても安全にスキップできるようにする。
interface LineMessageEvent {
  type?: string; // イベント種別 (message / follow / unfollow / postback 等)。message 以外は無視する
  replyToken?: string; // 返信用トークン (β では使わない)
  source?: {
    type?: string; // 送信元の種別 (user / group / room)
    userId?: string; // ユーザー ID (user タイプの場合のみ存在)
    groupId?: string; // グループ ID (group タイプの場合のみ存在)
    roomId?: string; // ルーム ID (room タイプの場合のみ存在)
  };
  message?: LineTextMessage | { type?: string }; // メッセージの中身 (テキスト以外は type だけ参照)
  timestamp?: number; // Unix ミリ秒のイベント発生時刻
}

// LINE が POST してくる Webhook ボディの型 (パース直後は信用せず events が配列かを実行時に検証する)
interface LineWebhookBody {
  destination?: string; // LINE チャネルのユーザー ID (受信先の特定に使えるが β では env var を使う)
  events?: LineMessageEvent[]; // 1 リクエストに複数イベントが含まれることがある
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

  // 署名ヘッダの存在を最初に確認する。未認証リクエストにサイズ情報を漏らさないため、
  // Content-Length チェックより前に行う (存在しなければ 401 を返して終了)。
  // trim() でプロキシが付加した余分な空白を除去してから比較する
  // (末尾に \n 等が付くと Buffer の長さが変わり定数時間比較が失敗して正規リクエストを弾く)
  const signature = req.headers.get('x-line-signature')?.trim() ?? null;
  if (!signature) {
    // 署名ヘッダが無いリクエストは LINE サーバからのものではないと判断して拒否する
    return NextResponse.json({ error: '署名ヘッダがありません' }, { status: 401 });
  }

  // Content-Length が上限超過なら本体を読む前に 413 で弾く (巨大ボディのメモリ枯渇防止 §9)。
  // || '-1' で null・空文字列どちらも -1 にまとめ「ヘッダ無し/不正値」として扱う。
  // -1 は MAX_REQUEST_BODY_BYTES より小さいのでプリチェックはスルーし、後段の読み込み後チェックに委ねる。
  const contentLength = Number(req.headers.get('content-length') || '-1');
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BODY_BYTES) {
    // サイズ超過はサーバーログに残し、外部には詳細を出さない 413 を返す
    console.warn(
      `[POST /api/inbound/line] request body too large (header): ${contentLength} bytes`,
    );
    return NextResponse.json({ error: 'リクエストが大きすぎます' }, { status: 413 });
  }

  // ボディを文字列として読み込む (署名検証は JSON.parse 前の生テキストに対して行う必要がある)
  const rawBody = await req.text();
  // chunked 転送は Content-Length を省略できる。読み込み後に UTF-8 バイト数で実サイズを検査して
  // DoS を防ぐ (ヘッダ無しで巨大ボディを送り込む攻撃への対策 §9)。
  // rawBody.length は UTF-16 コードユニット数でバイト数と異なるため Buffer.byteLength を使う。
  const rawBodyBytes = Buffer.byteLength(rawBody, 'utf8');
  if (rawBodyBytes > MAX_REQUEST_BODY_BYTES) {
    // 実際の読み取りバイト数が上限超過: 413 で弾く
    console.warn(`[POST /api/inbound/line] request body too large (actual): ${rawBodyBytes} bytes`);
    return NextResponse.json({ error: 'リクエストが大きすぎます' }, { status: 413 });
  }

  // 署名を検証する (不正なら 401)
  if (!verifyLineSignature(rawBody, signature, channelSecret)) {
    // 署名不一致は LINE サーバからのものではないため拒否する (なりすまし POST の防止)
    return NextResponse.json({ error: '署名の検証に失敗しました' }, { status: 401 });
  }

  // 検証済みの生ボディを JSON としてパースする
  let body: LineWebhookBody;
  try {
    // 署名は検証済みだが JSON の中身は信用しない (構造は下で実行時チェックする)
    body = JSON.parse(rawBody) as LineWebhookBody;
  } catch (err) {
    // パース失敗は 400 (内容を外部に出さずログに記録する)
    console.error('[POST /api/inbound/line] failed to parse webhook body', err);
    return NextResponse.json({ error: 'リクエストの形式が正しくありません' }, { status: 400 });
  }

  // 署名検証済みでも JSON の構造は信用しない (§9 入力は信用しない)。events が配列でなければ
  // 以降の body.events.length / for-of が TypeError になるため、ここで 400 を返して握り潰さない
  if (!Array.isArray(body.events)) {
    console.warn('[POST /api/inbound/line] webhook body has no events array');
    return NextResponse.json({ error: 'リクエストの形式が正しくありません' }, { status: 400 });
  }

  // イベント数が上限を超える場合は起票せず 200 で「受領のみ」する。
  // 非 200 を返すと LINE は同じ巨大バッチを 5 分間再送し続けるため、再送を誘発しないよう 200 で破棄する。
  // (この判定は DB 参照より前に置き、過大バッチで無駄なクエリを投げないようにする)
  if (body.events.length > MAX_EVENTS_PER_REQUEST) {
    console.warn(
      `[POST /api/inbound/line] too many events in one request: ${body.events.length} (max ${MAX_EVENTS_PER_REQUEST})`,
    );
    return NextResponse.json({ status: 'ignored', reason: 'too_many_events' }, { status: 200 });
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

  // プランゲート: LINE 連携は Pro 以上のみ (Free / Standard では利用不可 §6.1 料金プラン)。
  // UI 非表示に頼らずサーバー側 (Webhook 受信口) で強制する。200 を返して LINE の再送ループを止める
  // (非 200 は LINE が 5 分以内に再送するため §9)。
  if (!isLineIntegrationAllowed(tenant.subscriptionPlan)) {
    console.warn('[POST /api/inbound/line] ignored: LINE integration not allowed for plan', {
      plan: tenant.subscriptionPlan,
    });
    return NextResponse.json({ status: 'ignored', reason: 'plan_not_allowed' }, { status: 200 });
  }

  // 未紐付け LINE ユーザー (またはユーザー ID 不明) のフォールバック起票者を用意する。
  // 紐付け済みユーザーは後段で本人を起票者にするが、未紐付けの問い合わせはテナント内の担当者を
  // 代理の起票者にする。listAgents は名前昇順で agent/admin を返すため、その先頭を代理起票者に使う。
  const agents = await repos.users.listAgents(targetTenantId);
  if (agents.length === 0) {
    // 担当者が 1 人もいないテナントは起票者を決められない。再送しても状況は変わらない
    // (設定不備) ため、LINE の再送ループを避けるべく 200 で「受領のみ」して破棄する。
    console.warn('[POST /api/inbound/line] no agents found for tenant:', targetTenantId);
    return NextResponse.json({ status: 'ignored', reason: 'no_agents' }, { status: 200 });
  }
  // 名前順で最初の担当者 (agent/admin) を未紐付けユーザー向けの代理起票者とする
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
    // 配列要素が null / 非オブジェクトでも落ちないように、まず event の存在とメッセージ種別を確認する
    if (event?.type !== 'message') continue;
    // メッセージ本体を取り出す (欠落していてもよいよう optional 扱い)
    const message = event.message;
    // テキストメッセージ以外 (スタンプ / 画像 / 動画 等) や message 欠落イベントはスキップする
    if (message?.type !== 'text') continue;

    // テキストメッセージとして型を確定させる (type==='text' を確認済み)
    const textMessage = message as LineTextMessage;
    // LINE ユーザー ID を取得する (source / userId が無い場合は '不明' とする)。
    // LINE の正規形式は 'U' + 32 桁 16 進数。署名検証済みでも形式外の値をそのままチケット本文に
    // 埋め込むと将来の出力経路 (HTML メール等) でインジェクションになりうるため §9 に従い検証する
    const rawUserId = event.source?.userId ?? '';
    // 形式が一致する場合のみ採用し、それ以外は '不明' に置き換える
    const lineUserId = LINE_USER_ID_PATTERN.test(rawUserId) ? rawUserId : '不明';
    // text が文字列でない (欠落・型不正) イベントは起票できないためスキップする
    if (typeof textMessage.text !== 'string') continue;

    // 空白のみのメッセージはタイトルが空文字列になるため起票対象外としてスキップする
    // (LINE は空文字メッセージを送信できる場合があり、Zod min(1) を持たないこのパスでは別途ガードが必要)
    const trimmedText = textMessage.text.trim();
    if (!trimmedText) continue;

    // メンバー紐付け: テキストが発行済みワンタイムコードなら、起票せず lineUserId をメンバーへ紐付ける。
    // (lineUserId が取得できないイベントは紐付けようがないので、この処理を飛ばして通常起票へ進む)
    if (lineUserId !== '不明') {
      // 受信テキストを正規化 (ハイフン・空白除去 + 大文字化) してコードの形か軽く判定する
      const normalizedCode = normalizeLineLinkCode(trimmedText);
      if (looksLikeLineLinkCode(normalizedCode)) {
        // 形が一致したらハッシュ化し、有効な発行行があれば原子的に紐付ける
        const codeHash = await hashLineLinkCode(normalizedCode);
        const link = await repos.users.linkLineUserByCode({
          codeHash,
          tenantId: targetTenantId,
          lineUserId,
          now,
        });
        // 連携成功 / 競合 (コードとして処理済み) のときは、このメッセージを問い合わせにしない
        if (link.status === 'linked' || link.status === 'conflict') {
          // 連携結果をログに残す (利用者は Web 設定画面の「連携済み」表示で連携状態を確認する)
          console.info(
            `[POST /api/inbound/line] line link ${link.status} for tenant`,
            targetTenantId,
          );
          continue;
        }
        // invalid (コードの形だが有効な発行行が無い) は通常の問い合わせとして下の起票へ進む
      }
    }

    // 起票者を決める: この LINE ユーザーが紐付け済みなら本人を起票者にして自己解決 UI を開通させる。
    // 未紐付け (または lineUserId 不明) は従来どおりプロキシ担当者を起票者にする (β フォールバック)。
    const linkedMember =
      lineUserId !== '不明' ? await repos.users.findByLineUserId(targetTenantId, lineUserId) : null;
    const creatorId = linkedMember ? linkedMember.id : proxyCreator.id;

    // チケットタイトルはメッセージテキストの先頭 MAX_TITLE_LENGTH 文字にする
    const title =
      trimmedText.length > MAX_TITLE_LENGTH
        ? `${trimmedText.slice(0, MAX_TITLE_LENGTH)}…`
        : trimmedText;

    // メッセージ本文をサーバー側でも上限に丸める (LINE の送信上限 5000 文字よりも大きい 10000 文字で守る)
    // プラットフォーム上限だけに頼らずサーバー側でも明示的に制限して DB への過大な書き込みを防ぐ。
    // trimmedText を使うことで先頭・末尾の空白を除いてから切り詰める (textMessage.text のままだと
    // 空白だけのメッセージが上の空白チェックをすり抜けた場合にチケット本文が空白だらけになる)。
    const safeText =
      trimmedText.length > MAX_BODY_LENGTH
        ? `${trimmedText.slice(0, MAX_BODY_LENGTH)}…`
        : trimmedText;

    // チケット本文: LINE ユーザー ID と全メッセージテキストを含める (担当者が手動連絡できるよう)
    const ticketBody = `[LINE 経由の問い合わせ]\nLINE ユーザー ID: ${lineUserId}\n\n${safeText}`;

    // 新規チケットを起票する (Web フォーム・メール取り込みと同じ PORT 経由)。
    // 1 件の起票失敗で全体を 500 にすると LINE がバッチ全体を再送し、既に起票済みのチケットが
    // 重複する (このルートはまだメッセージ ID による冪等化を持たない)。そのため起票は個別に
    // try/catch で囲み、失敗は文脈付きでログに残して次のイベントへ進み、最後は必ず 200 を返す。
    try {
      const ticket = await repos.tickets.create({
        title, // LINE メッセージから生成したタイトル
        body: ticketBody, // LINE ユーザー ID + 全文
        priority: 'Medium', // LINE 取り込みは優先度 Medium 固定 (他チャネルと揃える)
        categoryId: null, // カテゴリは未分類 (担当者が後で設定)
        creatorId, // 紐付け済みなら本人、未紐付けならプロキシ担当者 (上で解決済み)
        tenantId: targetTenantId, // 取り込み先テナント
        status: initialStatus, // Lite は 'Open'、Pro は DB 既定 'New'
        resolutionDueAt, // 優先度 Medium ベースの解決期限
      });
      // 起票したチケット ID を記録する
      ticketIds.push(ticket.id);
      // 起票成功後に担当者全員へ「新しい問い合わせが届きました」通知を送る (ベストエフォート)。
      // 失敗してもチケット起票自体は確定済みのため、ログを残して次のイベントへ進む (§9 fail-safe)。
      try {
        // 通知対象: 起票者がプロキシ担当者 (未紐付け) の場合は全担当者、本人起票なら起票者以外の担当者
        const notifyTargets = linkedMember
          ? agents.filter((a) => a.id !== creatorId) // 本人起票: 他担当者のみ
          : agents; // プロキシ起票: 全担当者に通知
        if (notifyTargets.length > 0) {
          // 各担当者へ通知を作成する。allSettled で 1 件失敗しても他を止めない
          const notifyResults = await Promise.allSettled(
            notifyTargets.map((a) =>
              repos.notifications.create({
                userId: a.id, // 通知受信者: 各担当者
                type: 'imported', // LINE からの取り込みによる新規起票通知 (inbound チャネルは 'imported' を使う)
                message: `LINE から新しい問い合わせが届きました：${title}`, // 通知文言
                ticketId: ticket.id, // 紐付けチケット
                tenantId: targetTenantId, // テナントスコープ
              }),
            ),
          );
          // 通知作成に成功した担当者 ID だけを SSE 配信対象にする (失敗分は DB レコードが無いためスキップ)
          const succeededIds = notifyTargets
            .filter((_, i) => notifyResults[i]?.status === 'fulfilled')
            .map((a) => a.id);
          const failedCount = notifyTargets.length - succeededIds.length;
          if (failedCount > 0) {
            // 失敗件数だけログに残す
            console.warn(
              `[POST /api/inbound/line] ${failedCount} notification(s) failed to create for ticket`,
              ticket.id,
            );
          }
          // 未読カウントを SSE で即時配信して通知ベルに反映させる (成功分のみ)
          if (succeededIds.length > 0) {
            await broadcastUnreadCountToMany(
              succeededIds, // 通知作成に成功した担当者 ID 一覧
              targetTenantId, // テナントスコープ
            ).catch((broadcastErr) => {
              // SSE 配信失敗はバッジ更新が遅れるだけ。ログのみ残して続行する
              console.warn(
                '[POST /api/inbound/line] failed to broadcast unread count',
                broadcastErr,
              );
            });
          }
        }
      } catch (notifyErr) {
        // 通知失敗はログのみ (チケット起票は完了しているため応答は成功扱いのまま)
        console.warn(
          '[POST /api/inbound/line] failed to notify agents for ticket',
          ticket.id,
          notifyErr,
        );
      }
    } catch (err) {
      // 起票失敗は握り潰さずログに残す。再送による重複起票を避けるため全体は 200 で受領する
      console.error('[POST /api/inbound/line] failed to create ticket from event', err);
    }
  }

  // LINE サーバーはレスポンスを所定時間内に受信しないと再送するため、必ず 200 を返す。
  // 冪等化 (LINE メッセージ ID による重複排除) はメール取り込みの Message-ID 方式に倣った将来課題。
  return NextResponse.json({ ticketIds }, { status: 200 });
}
