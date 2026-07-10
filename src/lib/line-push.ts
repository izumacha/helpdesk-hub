/**
 * LINE Messaging API push (Phase 2「担当者の返信が LINE に返る」/ docs/smb-dx-pivot-plan.md §4 Phase 2)。
 *
 * `POST /api/inbound/line` で連携 (lineUserId 紐付け) 済みのメンバーが起票したチケットに担当者が
 * コメント (返信) すると、依頼者がアプリにログインしなくても内容を確認できるよう LINE へ push する。
 * 既存のメール返信 (src/lib/ticket-email.ts) と同じ「何を送るか (純粋関数) / 送る (副作用)」の分離方針。
 *
 * アクセストークン (Messaging API の長期アクセストークン) はテナント単位の `TenantLineConfig`
 * (§4 Phase 2.1 フォローアップ) から呼び出し側が解決して渡す。この関数自体は環境変数を読まない
 * (呼び出し側でテナントの LINE 連携が未設定なら、そもそも呼び出されない想定)。
 */

// Webhook POST 共通ユーティリティ (タイムアウト・本文上限・リダイレクト非追従) を再利用する
import { postWebhook } from '@/lib/webhook-fetch';
// LINE ユーザー ID の正規形式 (受信 Webhook と共有する単一の源)
import { LINE_USER_ID_PATTERN } from '@/lib/line-link';
// データ層の Composition Root (Prisma 直叩きを避ける入口)。resolveLineAccessToken が使う
import { repos } from '@/data';
// tenantId → Tenant のリクエストスコープ共有キャッシュ (同一リクエスト内の重複 SELECT を回避する)
import { getCachedTenant } from '@/lib/tenant-cache';
// LINE 連携がテナントのプランで許可されているか (Pro/Enterprise 限定機能)
import { isLineIntegrationAllowed } from '@/lib/plan-guard';

// LINE Messaging API の push エンドポイント (固定ホスト。ユーザー入力ではないため SSRF の懸念はない)
const LINE_PUSH_API_URL = 'https://api.line.me/v2/bot/message/push';

// push 送信のタイムアウト (ミリ秒)。LINE 側の障害でコメント投稿処理がハングしないよう短めに設定する
const LINE_PUSH_TIMEOUT_MS = 5_000;

// レスポンス本文の上限読み取りバイト数 (LINE のエラーレスポンスは小さい JSON なので十分)
const LINE_PUSH_MAX_RESPONSE_BYTES = 1024;

// テナントに対して LINE push が実行できるかを解決し、可能ならアクセストークンを返す共通ヘルパー。
// 「テナントの TenantLineConfig を引く → プランが LINE 連携を許可するか確認する」という判定順序を
// comments/route.ts (コメント返信) と update-ticket.ts (ステータス変更) の両方が必要とするため、
// /code-review ultra 指摘対応: 個別に重複実装せずここに集約する
// (§6 DRY: 2 箇所目の複製が生じた時点で共通化する方針)。
// 依頼者側の LINE 連携有無 (lineUserId の null チェック) は呼び出し側が既に持っている情報なので、
// ここでは扱わない (テナント側の判定だけに責務を絞る)。
export async function resolveLineAccessToken(tenantId: string): Promise<string | null> {
  // テナントの LINE 連携設定 (アクセストークン) を取得する。未設定ならこのテナントは
  // LINE push を使わないので null を返す (Pro/Enterprise 限定機能の任意設定)
  const lineConfig = await repos.lineConfigs.findByTenant(tenantId);
  if (!lineConfig) return null;

  // プランゲート: LINE 連携は Pro/Enterprise 限定機能 (§6.1 料金プラン)。プランダウングレード後も
  // TenantLineConfig の行自体は削除されないため、存在チェックだけでは送信され続けてしまう。
  // UI 非表示に頼らずここでもサーバー側で強制する (§9)。getCachedTenant はリクエストスコープで
  // メモ化されるため、呼び出し元が同一リクエスト内で既に Tenant を取得済みなら追加の SELECT は発生しない
  const tenant = await getCachedTenant(tenantId);
  if (!tenant || !isLineIntegrationAllowed(tenant.subscriptionPlan)) return null;

  return lineConfig.channelAccessToken;
}

// LINE のテキストメッセージ 1 件あたりの上限文字数 (Messaging API 仕様)。
// コメント本文は最大 5000 文字 (commentBodySchema) でほぼ同じだが、件名・URL 等を足すと
// 超過しうるためサーバー側でも明示的に切り詰める。
const LINE_TEXT_MESSAGE_MAX_LENGTH = 5000;

// 担当者の返信を LINE のテキストメッセージ本文として組み立てる純粋関数 (副作用なし)
export function buildTicketReplyLineMessage(input: {
  ticketTitle: string; // 問い合わせの件名
  ticketUrl: string; // チケット詳細ページの URL (アプリでの続きの確認用)
  commentBody: string; // 担当者が投稿した返信本文
  agentName: string; // 返信した担当者の表示名
}): string {
  // LINE はプレーンテキストのみのため、改行区切りの簡潔な文面にする (メールの HTML 版に相当する装飾はない)
  const text = [
    `${input.agentName} さんから、お問い合わせ「${input.ticketTitle}」に返信がありました。`,
    '',
    input.commentBody,
    '',
    '続きの確認はこちら:',
    input.ticketUrl,
  ].join('\n');

  // LINE の文字数上限を超える場合は末尾を省略する (上限超過は 400 エラーになるため事前に丸める)
  return text.length > LINE_TEXT_MESSAGE_MAX_LENGTH
    ? `${text.slice(0, LINE_TEXT_MESSAGE_MAX_LENGTH - 1)}…`
    : text;
}

// ステータス変更を LINE のテキストメッセージ本文として組み立てる純粋関数 (副作用なし)。
// §5.4 フォローアップ: これまで LINE push はコメント返信 (buildTicketReplyLineMessage) にしか
// 実装されておらず、ステータス変更はメールのみだった。ギャップ分析表 (§2) の「通知」行が
// 「メール通知」＆「LINE 通知」を通知の主軸とする方針だったため、同じ主要イベントである
// ステータス変更にも LINE 通知を追加する。
export function buildTicketStatusChangedLineMessage(input: {
  ticketTitle: string; // 問い合わせの件名
  ticketUrl: string; // チケット詳細ページの URL (アプリでの続きの確認用)
  oldStatusLabel: string; // 変更前ステータスの日本語ラベル (mode-aware。呼び出し側で解決済み)
  newStatusLabel: string; // 変更後ステータスの日本語ラベル (同上)
}): string {
  // LINE はプレーンテキストのみのため、改行区切りの簡潔な文面にする (メールの HTML 版に相当する装飾はない)
  const text = [
    `お問い合わせ「${input.ticketTitle}」の状況が更新されました。`,
    `${input.oldStatusLabel} → ${input.newStatusLabel}`,
    '',
    '詳細はこちら:',
    input.ticketUrl,
  ].join('\n');

  // LINE の文字数上限を超える場合は末尾を省略する (buildTicketReplyLineMessage と同じ安全策)
  return text.length > LINE_TEXT_MESSAGE_MAX_LENGTH
    ? `${text.slice(0, LINE_TEXT_MESSAGE_MAX_LENGTH - 1)}…`
    : text;
}

// 優先度変更を LINE のテキストメッセージ本文として組み立てる純粋関数 (副作用なし)。
// §5.4.2 フォローアップ (2026-07-10): §5.4.1 は「優先度変更・担当者アサインへの LINE 通知拡張は
// 本フォローアップのスコープ外」と明記して見送っていたが、ステータス変更と並ぶ主要イベントであり、
// ギャップ分析表 (§2) の「メール通知＆LINE通知を主軸にする」方針を優先度変更にも揃える。
// buildTicketStatusChangedLineMessage と同じ構成の文面にする
export function buildTicketPriorityChangedLineMessage(input: {
  ticketTitle: string; // 問い合わせの件名
  ticketUrl: string; // チケット詳細ページの URL (アプリでの続きの確認用)
  oldPriorityLabel: string; // 変更前優先度の日本語ラベル (呼び出し側で解決済み)
  newPriorityLabel: string; // 変更後優先度の日本語ラベル (同上)
}): string {
  // LINE はプレーンテキストのみのため、改行区切りの簡潔な文面にする (メールの HTML 版に相当する装飾はない)
  const text = [
    `お問い合わせ「${input.ticketTitle}」の優先度が変更されました。`,
    `${input.oldPriorityLabel} → ${input.newPriorityLabel}`,
    '',
    '詳細はこちら:',
    input.ticketUrl,
  ].join('\n');

  // LINE の文字数上限を超える場合は末尾を省略する (buildTicketReplyLineMessage と同じ安全策)
  return text.length > LINE_TEXT_MESSAGE_MAX_LENGTH
    ? `${text.slice(0, LINE_TEXT_MESSAGE_MAX_LENGTH - 1)}…`
    : text;
}

// 指定した LINE ユーザーへテキストメッセージを push する。
// accessToken が空文字ならこのテナントで LINE 連携が未設定 (または未対応プラン) であることを
// 意味し、何もしない (任意機能のためサイレントにスキップする)。
// HTTP エラー時は例外を投げる (呼び出し側がベストエフォートとして catch する設計)。
export async function pushLineMessage(
  accessToken: string,
  lineUserId: string,
  text: string,
): Promise<void> {
  // アクセストークン未設定はこのテナントで LINE push が無効であることを意味する (フィーチャーフラグ的に扱う)
  const trimmedToken = accessToken.trim();
  if (!trimmedToken) return;

  // 紐付け済み lineUserId は DB 由来だが、JSON ボディに載せる前に形式を再検証する (防御的多層化)。
  // 形式外の値を送っても LINE 側で 400 になるだけだが、外部 API へ無駄なリクエストを送らずに済む。
  if (!LINE_USER_ID_PATTERN.test(lineUserId)) {
    console.error('[line-push] 不正な LINE ユーザー ID 形式のため push をスキップしました');
    return;
  }

  // Messaging API へ push する。共通ヘルパーがタイムアウト・本文上限読み取り・リダイレクト非追従を担う。
  const { ok, status } = await postWebhook(LINE_PUSH_API_URL, {
    headers: {
      'Content-Type': 'application/json',
      // 長期アクセストークンを Bearer 認証で渡す (LINE Messaging API 仕様)
      Authorization: `Bearer ${trimmedToken}`,
    },
    body: JSON.stringify({
      to: lineUserId,
      messages: [{ type: 'text', text }],
    }),
    timeoutMs: LINE_PUSH_TIMEOUT_MS,
    maxResponseBytes: LINE_PUSH_MAX_RESPONSE_BYTES,
  });

  // セキュリティ: エラー詳細 (本文) はアクセストークン同様サーバーログのみに残し、例外メッセージには
  // ステータスコードだけを含める (呼び出し側がそのままログに残しても秘匿情報が漏れないようにする)
  if (!ok) {
    throw new Error(`LINE push 送信失敗: HTTP ${status}`);
  }
}
