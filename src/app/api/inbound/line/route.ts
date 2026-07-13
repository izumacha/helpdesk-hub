/**
 * LINE 公式アカウント Webhook (Phase 2 β / docs/smb-dx-pivot-plan.md §4 Phase 2 / §4 Phase 2.1 / §5.3)
 *
 * LINE 公式アカウントに送られたテキストメッセージを受信し、テナントの問い合わせ (Ticket) として
 * 取り込む。複数イベントを 1 リクエストで受け取ることがあるため、テキストメッセージ以外は無視して
 * 全イベントを処理してから 200 を返す (LINE は 200 未受信で 5 分以内に再送するため必ず 200 を返す)。
 *
 * マルチテナント化 (§4 Phase 2.1 / 2026-07-06 フォローアップ):
 *  - チャネルごとの認証情報 (channelSecret / channelAccessToken) はテナント単位の
 *    `TenantLineConfig` (DB) で管理する (旧: 環境変数 LINE_CHANNEL_SECRET / LINE_TARGET_TENANT_ID
 *    による 1 デプロイ環境 = 1 テナント決め打ちの β 制約を解消)。
 *  - テナント解決: LINE Webhook が送ってくる `destination` (このチャネル自身の Bot User ID。
 *    署名鍵ではない公開識別子) で `TenantLineConfig.botUserId` を引く。署名検証前の値なので、
 *    これ単体では「どのテナント宛か」の手がかりに過ぎず、実際の認証は次の署名検証が担う
 *    (メール取り込みの `inboundToken` と同じ「公開識別子でテナントを特定 → 秘密鍵で認証」設計)。
 *  - チャネル未登録・署名不一致のどちらも同一の 401 を返す (どちらが原因かを外部に漏らさない)。
 *  - 1 テナント / 1 LINE チャネルの制約自体は β のまま (マルチチャネル/1 テナントは将来課題)。
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
 *  - 未登録チャネル・シークレット不一致は fail-closed (401 で取り込み口を閉じ、理由は漏らさない)。
 *  - レート制限は 2 段構え: テナント解決 (DB 参照) 前は攻撃者が操作できない固定キーで
 *    全体の上限を設け (destination を変え続けるレート制限回避を防ぐ)、解決後は信頼できる
 *    tenantId をキーにしたチャネル単位の上限で個別テナントのバーストに備える。
 */

// JSON レスポンスヘルパー
import { NextResponse } from 'next/server';
// 署名検証に使う HMAC ユーティリティ (Node ランタイム前提)
import { createHmac } from 'node:crypto';
// 定数時間比較の共通ヘルパー (trial-reminders の Bearer トークン検証と共有)
import { constantTimeStringEqual } from '@/lib/timing-safe-compare';
// データ層の Composition Root (テナント / ユーザー / チケットのリポジトリ束)
import { repos } from '@/data';
// Webhook 再送に対する冪等起票の共通ヘルパー (LINE/メールで共有)
import {
  createTicketIdempotent,
  lineMessageIdempotencyOps,
} from '@/lib/idempotent-ticket-creation';
// 新規起票時の初期ステータスを mode から決める共通ルール (Web フォーム起票と単一の源を共有)
import { initialStatusForMode } from '@/domain/ticket-status';
// 公開エンドポイントの流量制限 (§9: DoS / リソース枯渇防止。Route Handler 向け共通ラッパー)
import { checkRouteRateLimit } from '@/lib/route-rate-limit';
// 優先度から解決期限を計算する SLA ヘルパー (他の取り込みチャネルと同じ既定値に揃える)
import { calculateFirstResponseDueAt, calculateResolutionDueAt } from '@/lib/sla';
// LINE メンバー紐付け: 受信テキストの正規化・コード形判定・ハッシュ化 (発行は Web 設定画面側)
// LINE ユーザー ID の正規形式 (line-push.ts と共有する単一の源)
import {
  hashLineLinkCode,
  LINE_USER_ID_PATTERN,
  looksLikeLineLinkCode,
  normalizeLineLinkCode,
} from '@/lib/line-link';
// 新規起票の担当者通知ヘルパー (メール取り込みと共有。通知作成 + SSE 配信を内包する)
import { notifyAgentsOfNewTicket } from '@/features/notifications/notify';
// LINE 連携機能のプランゲート (§6.1 料金プラン: Pro / Enterprise のみ利用可能)
import { isLineIntegrationAllowed, resolveEffectivePlan } from '@/lib/plan-guard';
// Phase 4: Slack/Teams/Chatwork 外部通知ヘルパー (Web フォーム・メール取り込み・CSV インポートと共有)
import { notifyNewTicketOutbound } from '@/lib/outbound-notify';
// Phase 4 課金: 月間チケット上限チェック (Web フォーム・CSV インポートと共有)
import { getMonthlyTicketQuota, type MonthlyTicketQuota } from '@/lib/tenant-plan';
// このルートは Node ランタイムで動かす (node:crypto / Prisma を使うため Edge では動かない)
export const runtime = 'nodejs';

// テナント解決 (DB 参照) より前に適用する、固定キーの全体レート制限。
// destination は署名検証前の値で攻撃者が自由に生成できるため、これをレート制限のキーに
// 使うと値を毎回変えるだけで無制限に新しいバケットが作られ、事実上レート制限を回避されて
// しまう (バケット数の際限ない増加は enforceRateLimit 内の全体掃除処理の負荷も増やす)。
// そのため DB 参照 (findByBotUserId) の前段では固定キーで「未認証リクエスト全体」の上限を
// 設け、destination をどれだけ変えても DB 参照の総量が頭打ちになるようにする。
const LINE_UNAUTHENTICATED_RATE_LIMIT = { limit: 600, windowMs: 60_000 } as const;

// テナント解決後に適用する、チャネル (テナント) 単位の取り込み流量上限
// (シークレット漏洩時のスパムを抑える)。lineConfig.tenantId は DB 由来の信頼できる値
// (botUserId の @unique 制約でテナントと 1:1) なので、これをキーにする。
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
  destination?: string; // このチャネル自身の Bot User ID (テナント解決キー。署名検証前は未信用の値)
  events?: LineMessageEvent[]; // 1 リクエストに複数イベントが含まれることがある
}

// repos.users.listAgents() が返す配列の要素 1 件分の型 (agents / proxyCreator で共有する)
type LineAgent = Awaited<ReturnType<typeof repos.users.listAgents>>[number];

// 1 リクエスト内の全イベントで共通して使う文脈。POST 内で 1 度だけ解決した値を
// processLineEvent に渡し、イベントごとに DB を引き直さずに済ませる。
interface LineEventContext {
  targetTenantId: string; // 取り込み先テナント ID
  agents: LineAgent[]; // テナント内の agent/admin 一覧 (通知先解決に使う)
  proxyCreator: LineAgent; // 未紐付けユーザー向けの代理起票者 (agents の先頭)
  now: Date; // 起票時刻 (SLA 期限計算の基準)
  initialStatus: ReturnType<typeof initialStatusForMode>; // 初期ステータス (mode 依存)
  resolutionDueAt: ReturnType<typeof calculateResolutionDueAt>; // 優先度 Medium ベースの解決期限
  firstResponseDueAt: ReturnType<typeof calculateFirstResponseDueAt>; // 優先度 Medium ベースの初回応答期限
  quota: MonthlyTicketQuota; // 月間チケット上限の残枠 (イベントごとに消費するミュータブルなカウンタ)
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

  // 定数時間比較 (共通ヘルパー。長さが違う場合は早期 false)
  return constantTimeStringEqual(signature, expected);
}

// POST /api/inbound/line : LINE Webhook を受信してチケットを作成する
export async function POST(req: Request) {
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

  // ボディを JSON としてパースする。この時点では署名未検証なので中身は一切信用しない。
  // 唯一の目的は「どのチャネル (テナント) 宛かを示す公開識別子 (destination)」を取り出すことだけ。
  let body: LineWebhookBody;
  try {
    body = JSON.parse(rawBody) as LineWebhookBody;
  } catch (err) {
    // パース失敗は 400 (内容を外部に出さずログに記録する)
    console.error('[POST /api/inbound/line] failed to parse webhook body', err);
    return NextResponse.json({ error: 'リクエストの形式が正しくありません' }, { status: 400 });
  }

  // 署名検証前でも JSON の構造は信用しない (§9 入力は信用しない)。events が配列でなければ
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

  // destination (このチャネル自身の Bot User ID) を取り出す。署名鍵ではない公開識別子だが、
  // 正規の LINE ユーザー ID と同じ 'U' + 32 桁 16 進数の形式に必ず従うため、ここで形式を検証する
  // (形式外の値をそのまま DB 検索に使わない §9)。欠落・形式不正はテナントを
  // 特定できないため、以降の「チャネル未登録」「署名不一致」と同一の 401 で拒否する
  // (どの理由で失敗したかを外部に区別させない fail-closed)。
  const destination = typeof body.destination === 'string' ? body.destination : '';
  if (!LINE_USER_ID_PATTERN.test(destination)) {
    return NextResponse.json({ error: '署名の検証に失敗しました' }, { status: 401 });
  }

  // 固定キーの全体レート制限を適用する (DB 参照より前に置き、destination を変え続ける
  // ことでのレート制限回避・DB 負荷増大を防ぐ。詳細は定数の定義コメント参照)
  const unauthLimitResponse = checkRouteRateLimit(
    'inbound-line:unauthenticated',
    LINE_UNAUTHENTICATED_RATE_LIMIT,
    '取り込みが混み合っています',
  );
  if (unauthLimitResponse) return unauthLimitResponse;

  // destination からテナントの LINE 連携設定 (チャネルシークレット等) を引く。
  // 未登録チャネルは「どのテナントの鍵で検証すべきか」が分からないため、この時点で拒否する
  // (署名不一致と同一メッセージ・ステータスにして、チャネル登録の有無を外部に漏らさない)。
  const lineConfig = await repos.lineConfigs.findByBotUserId(destination);
  if (!lineConfig) {
    return NextResponse.json({ error: '署名の検証に失敗しました' }, { status: 401 });
  }

  // テナントが解決できたので、ここからは信頼できる tenantId をキーにしたチャネル単位の
  // レート制限を適用する (destination のような攻撃者が操作可能な値はキーに使わない)。
  const tenantLimitResponse = checkRouteRateLimit(
    `inbound-line:${lineConfig.tenantId}`,
    LINE_RATE_LIMIT,
    '取り込みが混み合っています',
  );
  if (tenantLimitResponse) return tenantLimitResponse;

  // このチャネル (テナント) 専用のシークレットで署名を検証する (不正なら 401)
  if (!verifyLineSignature(rawBody, signature, lineConfig.channelSecret)) {
    // 署名不一致は LINE サーバからのものではないため拒否する (なりすまし POST の防止)
    return NextResponse.json({ error: '署名の検証に失敗しました' }, { status: 401 });
  }

  // ここまでで署名検証済み: 以降は body の中身を信用してよい
  const targetTenantId = lineConfig.tenantId;

  // 取り込み先テナントを ID で引く (botUserId の @unique 制約により通常は必ず見つかるが、
  // データ不整合に備えた防御的チェック)
  const tenant = await repos.tenants.findById(targetTenantId);
  if (!tenant) {
    // 署名検証済みのチャネルなのにテナントが見つからない場合はデータ不整合としてログに残す
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
  // 初回応答期限も同じく優先度 Medium ベースで自動算出する
  const firstResponseDueAt = calculateFirstResponseDueAt('Medium', now);
  // §7.2 Free trial 中の実効プラン (Standard 相当への昇格を含む)。LINE 連携自体は Pro 以上限定
  // (トライアルで昇格しない。上の isLineIntegrationAllowed は契約プランのまま判定する) だが、
  // 月間チケット上限は他の起票経路 (Web フォーム・メール取り込み) と同じくトライアル昇格を
  // 適用するのが一貫している。ここに到達する時点で契約プランは pro/enterprise 確定のため
  // resolveEffectivePlan は事実上の恒等関数だが、他経路との SSOT を揃えて将来の変更に備える
  const effectivePlan = resolveEffectivePlan(tenant.subscriptionPlan, tenant.trialEndsAt, now);
  // Phase 4 課金: 月間チケット上限の残枠を 1 度だけ取得する (Web フォーム・CSV インポートと共有)。
  // 1 リクエストに複数イベントが含まれうるため、イベントごとに ctx.quota.remaining を消費する
  const quota = await getMonthlyTicketQuota(targetTenantId, effectivePlan);

  // 1 リクエストに含まれる複数イベントを順に処理してチケットを起票する。
  // 1 件ずつの詳細処理は processLineEvent に委譲し、ここでは結果 (チケット ID) の収集に専念する。
  const eventContext: LineEventContext = {
    targetTenantId, // 取り込み先テナント ID
    agents, // テナント内の agent/admin 一覧 (通知先解決に使う)
    proxyCreator, // 未紐付けユーザー向けの代理起票者
    now, // 起票時刻 (SLA 期限計算の基準)
    initialStatus, // 初期ステータス (mode 依存)
    resolutionDueAt, // 優先度 Medium ベースの解決期限
    firstResponseDueAt, // 優先度 Medium ベースの初回応答期限
    quota, // 月間チケット上限の残枠
  };
  const ticketIds: string[] = [];
  for (const event of body.events) {
    const ticketId = await processLineEvent(event, eventContext);
    // null はスタンプ/空メッセージ/連携コード処理/起票失敗など「起票しなかった」ことを意味する
    if (ticketId) ticketIds.push(ticketId);
  }

  // LINE サーバーはレスポンスを所定時間内に受信しないと再送するため、必ず 200 を返す。
  // 冪等化 (メッセージ ID による重複排除) は、起票を伴う通常メッセージは createTicketIdempotent
  // の Serializable トランザクションで、連携コード処理 (起票を伴わない) は repos.lineLinkCodes
  // (LineLinkCodeRef テーブルへの DB 永続化) でそれぞれ担保している。
  return NextResponse.json({ ticketIds }, { status: 200 });
}

// LINE Webhook イベント 1 件を処理する。起票 (または重複判定) できた場合はチケット ID を返し、
// スタンプ/空メッセージ/連携コード処理/起票失敗など「起票しない」イベントは null を返す。
// POST から呼び出す前提の内部ヘルパーのため export しない。
async function processLineEvent(
  event: LineMessageEvent,
  ctx: LineEventContext,
): Promise<string | null> {
  // 文脈オブジェクトから各値を取り出す (POST 側で 1 度だけ解決済み)
  const {
    targetTenantId,
    agents,
    proxyCreator,
    now,
    initialStatus,
    resolutionDueAt,
    firstResponseDueAt,
  } = ctx;

  // 配列要素が null / 非オブジェクトでも落ちないように、まず event の存在とメッセージ種別を確認する
  if (event?.type !== 'message') return null;
  // メッセージ本体を取り出す (欠落していてもよいよう optional 扱い)
  const message = event.message;
  // テキストメッセージ以外 (スタンプ / 画像 / 動画 等) や message 欠落イベントはスキップする
  if (message?.type !== 'text') return null;

  // テキストメッセージとして型を確定させる (type==='text' を確認済み)
  const textMessage = message as LineTextMessage;
  // LINE ユーザー ID を取得する (source / userId が無い場合は '不明' とする)。
  // LINE の正規形式は 'U' + 32 桁 16 進数。署名検証済みでも形式外の値をそのままチケット本文に
  // 埋め込むと将来の出力経路 (HTML メール等) でインジェクションになりうるため §9 に従い検証する
  const rawUserId = event.source?.userId ?? '';
  // 形式が一致する場合のみ採用し、それ以外は '不明' に置き換える
  const lineUserId = LINE_USER_ID_PATTERN.test(rawUserId) ? rawUserId : '不明';
  // text が文字列でない (欠落・型不正) イベントは起票できないためスキップする
  if (typeof textMessage.text !== 'string') return null;

  // 空白のみのメッセージはタイトルが空文字列になるため起票対象外としてスキップする
  // (LINE は空文字メッセージを送信できる場合があり、Zod min(1) を持たないこのパスでは別途ガードが必要)
  const trimmedText = textMessage.text.trim();
  if (!trimmedText) return null;

  // 冪等化キー (このメッセージが再送かどうかの突き合わせに使う)。
  // id が欠落/非文字列 (想定外の応答) のときは突き合わせできないため null にする
  const messageId = typeof textMessage.id === 'string' && textMessage.id ? textMessage.id : null;

  // 冪等化の早期チェック (fast path): このメッセージ ID を既に取り込み済みなら、
  // 連携コード判定や起票者解決などの以降の処理を行わずに既存チケット ID を返す。
  // LINE は Webhook 応答が遅延/未受信だと同一メッセージを 5 分以内に再送する (at-least-once)。
  // これは事前チェックに過ぎず、実際の二重起票防止は createTicketIdempotent 内の
  // Serializable トランザクションが保証する (このチェック単体では TOCTOU の窓が残るため)。
  if (messageId) {
    const existingTicketId = await repos.lineMessages.findTicketIdByMessageId(
      messageId,
      targetTenantId,
    );
    if (existingTicketId) {
      // 既知のメッセージ ID: 二重起票を避けて既存チケット ID を返す
      console.info(
        `[POST /api/inbound/line] duplicate message id, skipping re-create: ${messageId}`,
      );
      return existingTicketId;
    }
  }

  // メンバー紐付け: テキストが発行済みワンタイムコードなら、起票せず lineUserId をメンバーへ紐付ける。
  // (lineUserId が取得できないイベントは紐付けようがないので、この処理を飛ばして通常起票へ進む)
  if (lineUserId !== '不明') {
    // 受信テキストを正規化 (ハイフン・空白除去 + 大文字化) してコードの形か軽く判定する
    const normalizedCode = normalizeLineLinkCode(trimmedText);
    if (looksLikeLineLinkCode(normalizedCode)) {
      // 連携コード処理は起票を伴わないため lineMessages 対応表の冪等化対象外になる。
      // この messageId を連携コードとして処理済みなら、再度 linkLineUserByCode を
      // 呼ばずに即座にスキップする (再送で「コードは消費済み → invalid → 誤起票」になるのを防ぐ)
      if (messageId && (await repos.lineLinkCodes.wasProcessed(messageId))) {
        console.info(
          `[POST /api/inbound/line] duplicate link-code message, skipping: ${messageId}`,
        );
        return null;
      }
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
        // この messageId を「連携コードとして処理済み」に記録する (再送時の誤起票防止)。
        // /code-review ultra 指摘対応: DB 永続化 (lineLinkCodes) に切り替えたことで、
        // 連携成功直後にプロセス再起動/デプロイが挟まっても記録が失われず、単一インスタンスの
        // 場合はもちろん、複数インスタンス間でも共有される (水平スケール環境でも安全)
        if (messageId) await repos.lineLinkCodes.markProcessed(messageId);
        return null;
      }
      // invalid (コードの形だが有効な発行行が無い) は通常の問い合わせとして下の起票へ進む
      // (typo 等の本来の invalid はメッセージ ID 冪等化の対象になるため再送で二重起票しない)。
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

  // Phase 4 課金: 月間チケット上限チェック (Web フォーム・CSV インポート・メール取り込みと共有)。
  // tenant-plan.ts のコメントで「全ての起票入口で共有する」と明記されているにもかかわらず、
  // LINE 取り込みだけこのチェックを呼んでいなかった。現状 LINE 連携が使えるプラン (Pro 以上) は
  // 月間上限が無制限のため実害は無いが、将来上限が付いた瞬間にこの入口だけ無制限の抜け道に
  // なる SSOT 違反を防ぐため、他入口と揃えておく。1 リクエストに複数イベントが含まれうるため、
  // ctx.quota (POST 側で 1 度だけ取得) の残枠をイベントごとに消費する簡易カウンタとして扱う。
  if (ctx.quota.limited && ctx.quota.remaining <= 0) {
    console.warn(`[POST /api/inbound/line] ignored: monthly ticket quota reached: ${messageId}`);
    return null;
  }

  // 新規チケットを起票する (Web フォーム・メール取り込みと同じ PORT 経由)。
  // 1 件の起票失敗で全体を 500 にすると LINE がバッチ全体を再送し、既に起票済みのチケットが
  // 重複する。そのため起票は try/catch で囲み、失敗は文脈付きでログに残して null を返す
  // (呼び出し側 POST は必ず 200 を返す。再送そのものは createTicketIdempotent の Serializable
  // トランザクションが二重起票を防ぐ)。
  try {
    // 起票 (+ メッセージ ID 登録) を 1 トランザクションで原子的に行う。
    // alreadyExisted が true のときは、書き込み競合で中断された後の再確認で「他リクエストが
    // 既に起票済み」と判明したケース (通知は既にそちらのリクエストで送られているはず)
    const { id: ticketId, alreadyExisted } = await createTicketIdempotent(
      lineMessageIdempotencyOps,
      messageId,
      targetTenantId,
      {
        title, // LINE メッセージから生成したタイトル
        body: ticketBody, // LINE ユーザー ID + 全文
        priority: 'Medium', // LINE 取り込みは優先度 Medium 固定 (他チャネルと揃える)
        categoryId: null, // カテゴリは未分類 (担当者が後で設定)
        creatorId, // 紐付け済みなら本人、未紐付けならプロキシ担当者 (上で解決済み)
        tenantId: targetTenantId, // 取り込み先テナント
        status: initialStatus, // Lite は 'Open'、Pro は DB 既定 'New'
        resolutionDueAt, // 優先度 Medium ベースの解決期限
        firstResponseDueAt, // 優先度 Medium ベースの初回応答期限
      },
    );
    if (alreadyExisted) {
      // 既に他リクエストが起票・通知済みのため、通知は送らずチケット ID だけ返す
      console.info(`[POST /api/inbound/line] resolved write conflict as duplicate: ${messageId}`);
      return ticketId;
    }
    // 上限のあるプランでは残枠を消費する (無制限プランは remaining が Infinity のため減算不要だが、
    // 明示的にガードして意図を示す。CSV インポートと同じパターン)
    if (ctx.quota.limited) ctx.quota.remaining -= 1;
    // 起票成功後に担当者全員へ「新しい問い合わせが届きました」通知を送る (ベストエフォート)。
    // 失敗してもチケット起票自体は確定済みのため、ログを残して続行する (§9 fail-safe)。
    try {
      // 通知対象: 起票者がプロキシ担当者 (未紐付け) の場合は全担当者、本人起票なら起票者以外の担当者
      const notifyTargets = linkedMember
        ? agents.filter((a) => a.id !== creatorId) // 本人起票: 他担当者のみ
        : agents; // プロキシ起票: 全担当者に通知
      // 通知作成・SSE 配信はメール取り込みと共有のヘルパーに委譲する (CLAUDE.md §6 DRY)
      await notifyAgentsOfNewTicket({
        tenantId: targetTenantId, // テナントスコープ
        ticketId, // 紐付けチケット
        message: `LINE から新しい問い合わせが届きました：${title}`, // 通知文言
        targets: notifyTargets, // 通知対象担当者一覧
        logPrefix: '[POST /api/inbound/line]', // ログの識別子
      });
    } catch (notifyErr) {
      // 通知失敗はログのみ (チケット起票は完了しているため応答は成功扱いのまま)
      console.warn(
        '[POST /api/inbound/line] failed to notify agents for ticket',
        ticketId,
        notifyErr,
      );
    }
    // Phase 4: 新規起票を Slack/Teams/Chatwork へ通知する (Web フォーム・メール・CSV と同じ経路)。
    // アプリ内通知とは独立したベストエフォート処理なので、失敗してもここまでの成功を巻き戻さない
    await notifyNewTicketOutbound(targetTenantId, { id: ticketId, title, priority: 'Medium' });
    return ticketId;
  } catch (err) {
    // 起票失敗は握り潰さずログに残す。再送による重複起票を避けるため呼び出し側は 200 で受領する
    console.error('[POST /api/inbound/line] failed to create ticket from event', err);
    return null;
  }
}
