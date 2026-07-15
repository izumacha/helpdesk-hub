// チケットのステータス変更・優先度変更を依頼者へ複数チャネル(メール・LINE)で届ける通知ヘルパー群。
// update-ticket.ts の Server Action 本体(トランザクション・履歴記録・アプリ内通知)から分離し、
// I/O ベストエフォート処理だけをこのモジュールに集約する
// (コードベース監査: update-ticket.ts が1002行に肥大化しており、単一責務に分割する余地があった)。
// 'use server' は付けない: このファイルは他の Server Action (update-ticket.ts) から呼ばれる
// 内部ヘルパーであり、クライアントから直接呼ばれる RPC エンドポイントではないため
// (§3 の規約: 'use server' は src/features/<domain>/actions/*.ts の Server Action 本体に限定)。

// リポジトリ束 (repos.users.findById で依頼者情報を取得する)
import { repos } from '@/data';
// ステータス・優先度の一元管理ラベル取得関数/定数
import { getStatusLabel, PRIORITY_LABELS } from '@/lib/constants';
// 型のみインポート (優先度/ステータス/テナントmode)
import type { Priority, TicketStatus, TenantMode } from '@/domain/types';
// ステータス変更・優先度変更のメール本文を生成する純粋ヘルパー
import { renderTicketStatusChangedEmail, renderPriorityChangedEmail, buildTicketUrl } from '@/lib/ticket-email';
// EmailSender 実装を取得するファクトリ (環境変数で console / smtp を切り替え)
import { getEmailSender } from '@/lib/email';
// メールに埋め込むリンクのベース URL を解決するヘルパー
import { resolveAppBaseUrl } from '@/lib/app-url';
// §5.4 フォローアップ: ステータス変更/優先度変更を依頼者へ LINE で届けるための本文組み立て + push 送信
// ヘルパー、および「テナントで LINE push が使えるか (連携設定 + プランゲート)」を解決する共通ヘルパー
import {
  buildTicketStatusChangedLineMessage,
  buildTicketPriorityChangedLineMessage,
  pushLineMessage,
  resolveLineAccessToken,
} from '@/lib/line-push';

// ステータス変更を依頼者へ複数チャネル (メール・LINE) で届ける内部ヘルパー (ベストエフォート)。
// /code-review ultra 指摘対応: メール用/LINE 用でそれぞれ個別に repos.users.findById(creatorId)
// していた重複呼び出しを解消するため、comments/route.ts の notifyRequesterOfReply と同じ
// 「依頼者情報を 1 度だけ引き、独立した I/O である各チャネルへ並行送信する」設計に揃える。
export async function notifyRequesterOfStatusChange(args: {
  ticketId: string; // 対象チケット ID (URL 構築用)
  ticketTitle: string; // チケット件名 (メール・LINE 本文用)
  creatorId: string; // 起票者ユーザー ID (メールアドレス・LINE 連携状況の取得用)
  oldStatus: TicketStatus; // 変更前のステータス (ラベル変換用)
  newStatus: TicketStatus; // 変更後のステータス (ラベル変換用)
  mode: TenantMode; // テナント mode (ラベル変換で Lite/Pro を切替)
  tenantId: string; // LINE 連携設定・プランの取得に使うテナントスコープ
}): Promise<void> {
  const { ticketId, ticketTitle, creatorId, oldStatus, newStatus, mode, tenantId } = args;
  // 依頼者の連絡先 (メールアドレス・LINE 連携状況) をまとめて 1 度だけ引く。
  // この呼び出し自体が失敗しても、コメント返信の notifyRequesterOfReply と同じ理由
  // (一過性の DB 障害で「ステータスは更新できたのに 500 が返る」事態を避ける) で握り潰す
  let creator: { email: string | null; lineUserId?: string | null } | null;
  try {
    creator = await repos.users.findById(creatorId);
  } catch (err) {
    console.error('[updateTicketStatus] 依頼者情報の取得に失敗しました', err);
    return;
  }
  // 依頼者自体が見つからなければメール / LINE どちらも送りようがないので早期 return する
  if (!creator) return;

  await Promise.all([
    sendStatusChangedEmailToRequester({
      creator,
      ticketId,
      ticketTitle,
      oldStatus,
      newStatus,
      mode,
    }),
    sendStatusChangedLineToRequester({
      creator,
      ticketId,
      ticketTitle,
      oldStatus,
      newStatus,
      mode,
      tenantId,
    }),
  ]);
}

// ステータス変更を依頼者へメールで通知する内部ヘルパー (ベストエフォート / 副作用は send のみ)。
// 例外は呼び出し側に伝播させず、ログに残して握り潰す: メール送信の失敗でチケット更新が
// 「保存できたのに 500 が返る」事態を避けるため。
async function sendStatusChangedEmailToRequester(args: {
  creator: { email: string | null }; // notifyRequesterOfStatusChange が 1 度だけ引いた依頼者情報
  ticketId: string; // 対象チケット ID (URL 構築用)
  ticketTitle: string; // チケット件名 (メール本文用)
  oldStatus: TicketStatus; // 変更前のステータス (ラベル変換用)
  newStatus: TicketStatus; // 変更後のステータス (ラベル変換用)
  mode: TenantMode; // テナント mode (ラベル変換で Lite/Pro を切替)
}): Promise<void> {
  const { creator, ticketId, ticketTitle, oldStatus, newStatus, mode } = args;
  // メール未設定なら送りようがないのでスキップ
  if (!creator.email) return;
  try {
    // ベース URL を解決する (production で NEXTAUTH_URL 未設定なら throw → 下で握る)
    const baseUrl = resolveAppBaseUrl();
    // チケット詳細ページへの導線 URL を組み立てる
    const ticketUrl = buildTicketUrl(baseUrl, ticketId);
    // ステータスの日本語ラベルを取得する (Lite/Pro どちらのモードかに応じて切替)
    const oldStatusLabel = getStatusLabel(oldStatus, mode);
    const newStatusLabel = getStatusLabel(newStatus, mode);
    // ステータス変更メールの件名 / テキスト / HTML を純粋ヘルパーで生成する
    const { subject, text, html } = renderTicketStatusChangedEmail({
      ticketTitle,
      ticketUrl,
      oldStatusLabel,
      newStatusLabel,
    });
    // 設定された EmailSender (console / smtp) 経由でメール送信
    await getEmailSender().send({ to: creator.email, subject, text, html });
  } catch (err) {
    // 送信失敗はサーバログに残すだけ (アプリ内通知は既に成立している)
    console.error('[updateTicketStatus] 依頼者宛ステータス変更メール送信に失敗しました', err);
  }
}

// ステータス変更を依頼者へ LINE で通知する内部ヘルパー (ベストエフォート / 副作用は push のみ)。
// テナントの LINE 連携が未設定、依頼者が LINE 未連携、またはプランが LINE 連携を許可しない場合は
// 早期 return で何もしない (機能オプトインの正常系。comments/route.ts の sendReplyLineToRequester と
// 同じ判定順序を踏襲する: 依頼者の連携 → テナントの連携設定 → プランゲート)。
// 例外は呼び出し側に伝播させず、ログに残して握り潰す (メール送信ヘルパーと同じ方針)。
async function sendStatusChangedLineToRequester(args: {
  creator: { lineUserId?: string | null }; // notifyRequesterOfStatusChange が 1 度だけ引いた依頼者情報
  ticketId: string; // 対象チケット ID (URL 構築用)
  ticketTitle: string; // チケット件名 (LINE 本文用)
  oldStatus: TicketStatus; // 変更前のステータス (ラベル変換用)
  newStatus: TicketStatus; // 変更後のステータス (ラベル変換用)
  mode: TenantMode; // テナント mode (ラベル変換で Lite/Pro を切替)
  tenantId: string; // LINE 連携設定・プランの取得に使うテナントスコープ
}): Promise<void> {
  const { creator, ticketId, ticketTitle, oldStatus, newStatus, mode, tenantId } = args;
  // LINE 未連携なら送りようがないのでスキップ
  if (!creator.lineUserId) return;

  try {
    // /code-review ultra 指摘対応: テナントの LINE 連携設定・プランゲートの判定は
    // comments/route.ts の sendReplyLineToRequester と重複していたため、
    // resolveLineAccessToken (src/lib/line-push.ts) へ共通化した
    const accessToken = await resolveLineAccessToken(tenantId);
    // null は「このテナントでは LINE push が使えない」を意味する (未設定 or プラン非対応)
    if (!accessToken) return;

    // ベース URL を解決する (production で NEXTAUTH_URL 未設定なら throw → 下で握る)
    const baseUrl = resolveAppBaseUrl();
    // チケット詳細ページへの導線 URL を組み立てる
    const ticketUrl = buildTicketUrl(baseUrl, ticketId);
    // ステータスの日本語ラベルを取得する (メールと同じ mode-aware 変換)
    const oldStatusLabel = getStatusLabel(oldStatus, mode);
    const newStatusLabel = getStatusLabel(newStatus, mode);
    // LINE 用テキスト本文を純粋ヘルパーで構築
    const text = buildTicketStatusChangedLineMessage({
      ticketTitle,
      ticketUrl,
      oldStatusLabel,
      newStatusLabel,
    });
    // Messaging API へ push する (このテナント専用のアクセストークンを使う)
    await pushLineMessage(accessToken, creator.lineUserId, text);
  } catch (err) {
    // 送信失敗はサーバログに残すだけ (アプリ内通知・メールは既に成立している)
    console.error('[updateTicketStatus] 依頼者宛ステータス変更 LINE 送信に失敗しました', err);
  }
}

// 優先度変更を依頼者へ複数チャネル (メール・LINE) で届ける内部ヘルパー (ベストエフォート)。
// §5.4.2 フォローアップ (2026-07-10): notifyRequesterOfStatusChange と同じ「依頼者情報を 1 度だけ
// 引き、独立した I/O である各チャネルへ Promise.all で並行送信する」設計 (以前はメール用ヘルパーが
// 個別に repos.users.findById(creatorId) しており、LINE 通知も未実装だった)。
export async function notifyRequesterOfPriorityChange(args: {
  ticketId: string; // 対象チケット ID (URL 構築用)
  ticketTitle: string; // チケット件名 (メール・LINE 本文用)
  creatorId: string; // 起票者ユーザー ID (メールアドレス・LINE 連携状況の取得用)
  oldPriority: Priority; // 変更前の優先度 (ラベル変換用)
  newPriority: Priority; // 変更後の優先度 (ラベル変換用)
  tenantId: string; // LINE 連携設定・プランの取得に使うテナントスコープ
}): Promise<void> {
  const { ticketId, ticketTitle, creatorId, oldPriority, newPriority, tenantId } = args;
  // 依頼者の連絡先 (メールアドレス・LINE 連携状況) をまとめて 1 度だけ引く。
  // この呼び出し自体が失敗しても notifyRequesterOfStatusChange と同じ理由で握り潰す
  let creator: { email: string | null; lineUserId?: string | null } | null;
  try {
    creator = await repos.users.findById(creatorId);
  } catch (err) {
    console.error('[updateTicketPriority] 依頼者情報の取得に失敗しました', err);
    return;
  }
  // 依頼者自体が見つからなければメール / LINE どちらも送りようがないので早期 return する
  if (!creator) return;

  await Promise.all([
    sendPriorityChangedEmailToRequester({
      creator,
      ticketId,
      ticketTitle,
      oldPriority,
      newPriority,
    }),
    sendPriorityChangedLineToRequester({
      creator,
      ticketId,
      ticketTitle,
      oldPriority,
      newPriority,
      tenantId,
    }),
  ]);
}

// 優先度変更を依頼者へメールで通知する内部ヘルパー (ベストエフォート / 副作用は send のみ)。
// sendStatusChangedEmailToRequester と同じく、例外は呼び出し側に伝播させずログに残して握り潰す。
async function sendPriorityChangedEmailToRequester(args: {
  creator: { email: string | null }; // notifyRequesterOfPriorityChange が 1 度だけ引いた依頼者情報
  ticketId: string; // 対象チケット ID (URL 構築用)
  ticketTitle: string; // チケット件名 (メール本文用)
  oldPriority: Priority; // 変更前の優先度 (ラベル変換用)
  newPriority: Priority; // 変更後の優先度 (ラベル変換用)
}): Promise<void> {
  const { creator, ticketId, ticketTitle, oldPriority, newPriority } = args;
  // メール未設定なら送りようがないのでスキップ
  if (!creator.email) return;
  try {
    // ベース URL を解決する (production で NEXTAUTH_URL 未設定なら throw → 下で握る)
    const baseUrl = resolveAppBaseUrl();
    // チケット詳細ページへの導線 URL を組み立てる
    const ticketUrl = buildTicketUrl(baseUrl, ticketId);
    // 優先度変更メールの件名 / テキスト / HTML を純粋ヘルパーで生成する
    const { subject, text, html } = renderPriorityChangedEmail({
      ticketTitle,
      ticketUrl,
      oldPriorityLabel: PRIORITY_LABELS[oldPriority] ?? oldPriority,
      newPriorityLabel: PRIORITY_LABELS[newPriority] ?? newPriority,
    });
    // 設定された EmailSender (console / smtp) 経由でメール送信
    await getEmailSender().send({ to: creator.email, subject, text, html });
  } catch (err) {
    // 送信失敗はサーバログに残すだけ (アプリ内通知は既に成立している)
    console.error('[updateTicketPriority] 依頼者宛優先度変更メール送信に失敗しました', err);
  }
}

// 優先度変更を依頼者へ LINE で通知する内部ヘルパー (ベストエフォート / 副作用は push のみ)。
// sendStatusChangedLineToRequester と同じ判定順序・失敗時の握り潰し方針を踏襲する。
async function sendPriorityChangedLineToRequester(args: {
  creator: { lineUserId?: string | null }; // notifyRequesterOfPriorityChange が 1 度だけ引いた依頼者情報
  ticketId: string; // 対象チケット ID (URL 構築用)
  ticketTitle: string; // チケット件名 (LINE 本文用)
  oldPriority: Priority; // 変更前の優先度 (ラベル変換用)
  newPriority: Priority; // 変更後の優先度 (ラベル変換用)
  tenantId: string; // LINE 連携設定・プランの取得に使うテナントスコープ
}): Promise<void> {
  const { creator, ticketId, ticketTitle, oldPriority, newPriority, tenantId } = args;
  // LINE 未連携なら送りようがないのでスキップ
  if (!creator.lineUserId) return;

  try {
    // テナントの LINE 連携設定・プランゲートの判定は resolveLineAccessToken に共通化済み
    const accessToken = await resolveLineAccessToken(tenantId);
    // null は「このテナントでは LINE push が使えない」を意味する (未設定 or プラン非対応)
    if (!accessToken) return;

    // ベース URL を解決する (production で NEXTAUTH_URL 未設定なら throw → 下で握る)
    const baseUrl = resolveAppBaseUrl();
    // チケット詳細ページへの導線 URL を組み立てる
    const ticketUrl = buildTicketUrl(baseUrl, ticketId);
    // LINE 用テキスト本文を純粋ヘルパーで構築
    const text = buildTicketPriorityChangedLineMessage({
      ticketTitle,
      ticketUrl,
      oldPriorityLabel: PRIORITY_LABELS[oldPriority] ?? oldPriority,
      newPriorityLabel: PRIORITY_LABELS[newPriority] ?? newPriority,
    });
    // Messaging API へ push する (このテナント専用のアクセストークンを使う)
    await pushLineMessage(accessToken, creator.lineUserId, text);
  } catch (err) {
    // 送信失敗はサーバログに残すだけ (アプリ内通知・メールは既に成立している)
    console.error('[updateTicketPriority] 依頼者宛優先度変更 LINE 送信に失敗しました', err);
  }
}
