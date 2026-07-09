// Phase 4: 外部通知チャネル (Slack / Teams / Chatwork) への送信ヘルパー。
// テナントに設定された各チャネルを見て、設定済みのチャネルすべてに送信する。
// 送信失敗はログに残すが、チケット操作自体は止めない (non-critical なサイドエフェクト)。
// あるチャネルの失敗が他チャネルの送信を妨げないよう、各チャネルは独立して送る。
// docs/smb-dx-pivot-plan.md §4 Phase 4「Slack / Chatwork / Microsoft Teams 通知 Adapter」。

// Slack Adapter のファクトリ関数
import { createSlackNotifier } from '@/data/adapters/slack/slack-notifier';
// Teams Adapter のファクトリ関数
import { createTeamsNotifier } from '@/data/adapters/teams/teams-notifier';
// Chatwork Adapter のファクトリ関数
import { createChatworkNotifier } from '@/data/adapters/chatwork/chatwork-notifier';
// 送信メッセージ型と通知契約型
import type { OutboundMessage, OutboundNotifier } from '@/data/ports/outbound-notifier';
// テナント情報取得 (各チャネル設定の参照)
import { repos } from '@/data';
// SSRF ガード: 送信直前に URL の安全性を再検証する (DNS リバインディング対策の二重防御)
import { isUnsafeUrl } from '@/lib/ssrf-guard';
// メール/通知本文に載せるチケット詳細ページの絶対 URL を組み立てるためのベース URL 解決ヘルパー
import { resolveAppBaseUrl } from '@/lib/app-url';
// 優先度の日本語ラベル (外部通知本文に使う)
import { PRIORITY_LABELS } from '@/lib/constants';
// 新規作成されたチケットの型 (通知本文の組み立てに使う最小限のフィールドのみ参照)、
// 外部通知チャネルの識別キー型 (唯一の参照元。ここでは再宣言しない §6 一元管理)、
// および失敗記録の有無判定に使う Tenant 型
import type { OutboundChannelKey, Tenant, Ticket } from '@/domain/types';

// notifyNewTicketOutbound が参照する最小限のチケット情報。
// メール/LINE 取り込みは冪等化ヘルパーが { id, alreadyExisted } しか返さず、通知のためだけに
// フル Ticket を再取得するのは無駄なため、呼び出し元が持つ最小限のフィールドだけ要求する。
export type NewTicketNotifyInput = Pick<Ticket, 'id' | 'title' | 'priority'>;

// 設定済みチャネルを表す内部型 (ログ・健全性記録用のキー/チャネル名と送信実体をペアで持つ)
interface ResolvedChannel {
  key: OutboundChannelKey; // 健全性記録用のキー (repos.tenants.recordOutboundChannelResult に渡す)
  name: string; // ログ表示用のチャネル名 (Slack / Teams / Chatwork)
  notifier: OutboundNotifier; // 実際の送信を行う Adapter
}

// 管理画面に表示する失敗メッセージの最大文字数 (Webhook/API のエラーレスポンスは長大な場合があるため
// DB 肥大化・画面崩れを防ぐ上限を設ける。§8 パフォーマンス)
const FAILURE_MESSAGE_MAX_LENGTH = 300;

// チャネルごとの直近失敗記録の有無を読む Tenant フィールド名。channelHasRecordedFailure が参照する
// (OutboundChannelKey → Tenant.<channel>LastFailureAt のフィールド名の対応表。§6 一元管理)
const CHANNEL_FAILURE_AT_FIELD = {
  slack: 'slackLastFailureAt', // Slack の直近失敗日時フィールド名
  teams: 'teamsLastFailureAt', // Teams の直近失敗日時フィールド名
  chatwork: 'chatworkLastFailureAt', // Chatwork の直近失敗日時フィールド名
} as const satisfies Record<OutboundChannelKey, string>;

// Webhook URL を SSRF チェックして安全なら channels リストへ追加する共通ヘルパー。
// Slack / Teams のように「ユーザーが入力した URL を保存して後で叩く」チャネルに共通して使う。
// Chatwork のような固定ホスト宛チャネルには不要なため呼ばない。
// 将来チャネルを追加するときも、このヘルパーを呼べば SSRF 二重防御を取り込める。
function addWebhookChannel(
  channels: ResolvedChannel[], // 追加先のチャネル一覧 (破壊的に追加する)
  key: OutboundChannelKey, // 健全性記録用のキー
  name: string, // ログ表示用のチャネル名
  url: string, // ユーザーが設定した Webhook URL
  factory: (url: string) => OutboundNotifier, // URL を受け取って Adapter を生成するファクトリ
): void {
  // SSRF 二重防御: 保存時 (update-notification-channels.ts) に検証済みだが、
  // DNS リバインディング攻撃 (登録後に内部 IP へ変更) を緩和するため送信直前にも再検証する。
  if (isUnsafeUrl(url)) {
    // 安全でない URL が DB に残っている場合はスキップしてエラーログを残す
    console.error(
      `[outbound-notify] SSRF ガード: 安全でない ${name} Webhook URL をスキップしました`,
    );
    // 安全でない URL にはリクエストを送らずここで終わる
    return;
  }
  // URL が安全であればチャネル一覧へ追加する
  channels.push({ key, name, notifier: factory(url) });
}

// 指定テナントの設定済み外部通知チャネルにメッセージを送信する。
// - チャネルが 1 つも設定されていなければ何もしない (通知無効の正常系)
// - 各チャネルの送信失敗はコンソールエラーに留め、呼び出し元 (Server Action) を止めない
// - あるチャネルの失敗が他チャネルへの送信を妨げないよう Promise.allSettled で並行送信する
export async function sendOutboundNotification(
  tenantId: string,
  message: OutboundMessage,
): Promise<void> {
  // テナント情報を取得して各チャネルの設定を確認する
  const tenant = await repos.tenants.findById(tenantId);
  // テナントが取得できなければ送信しない (正常終了)
  if (!tenant) return;

  // 設定済みチャネルを集める配列
  const channels: ResolvedChannel[] = [];

  // ── Slack ───────────────────────────────────────────────────────────────────
  // slackWebhookUrl が設定済みであれば SSRF 検証のうえチャネルへ追加する
  if (tenant.slackWebhookUrl) {
    addWebhookChannel(channels, 'slack', 'Slack', tenant.slackWebhookUrl, createSlackNotifier);
  }

  // ── Teams ───────────────────────────────────────────────────────────────────
  // teamsWebhookUrl が設定済みであれば SSRF 検証のうえチャネルへ追加する
  if (tenant.teamsWebhookUrl) {
    addWebhookChannel(channels, 'teams', 'Teams', tenant.teamsWebhookUrl, createTeamsNotifier);
  }

  // ── Chatwork ──────────────────────────────────────────────────────────────────
  // API トークンとルーム ID の両方が揃っているときだけ Chatwork チャネルを追加する。
  // 送信先ホストは api.chatwork.com 固定 (ユーザー入力ではない) のため SSRF 検証は不要。
  if (tenant.chatworkApiToken && tenant.chatworkRoomId) {
    channels.push({
      key: 'chatwork',
      name: 'Chatwork',
      notifier: createChatworkNotifier(tenant.chatworkApiToken, tenant.chatworkRoomId),
    });
  }

  // 設定済みチャネルが 1 つも無ければ送信しない (正常終了)
  if (channels.length === 0) return;

  // 全チャネルへ並行送信する。1 つが失敗しても他チャネルの送信は止めない (allSettled)
  const results = await Promise.allSettled(channels.map((c) => c.notifier.send(message)));

  // 監査で発見したギャップ対応: 失敗はログに残すだけでなく、管理画面で気づけるよう
  // Tenant の直近失敗記録にも書き込む。成功時は「前回失敗が記録されているときだけ」クリアし、
  // 毎回 DB を書きに行かないようにする (§8 パフォーマンス)。この記録処理自体の失敗は
  // ログに残すのみに留め、本来の送信結果判定には影響させない (非クリティカルな副作用)。
  await Promise.all(
    results.map(async (result, index) => {
      const channel = channels[index];
      // このチャネルの直近失敗記録が既にあるかどうか (成功時の不要な書き込みを避けるため)
      const hadPriorFailure = channelHasRecordedFailure(tenant, channel.key);
      try {
        if (result.status === 'rejected') {
          // どのチャネルで失敗したかを明示してログに残す。
          // セキュリティ: reason の詳細はサーバーログのみに残し、レスポンスには含めない
          console.error(
            `[outbound-notify] ${channel.name} 通知の送信に失敗しました:`,
            result.reason,
          );
          // 管理画面向けに直近の失敗日時・概要メッセージを記録する (履歴ではなく最新 1 件のみ)
          await repos.tenants.recordOutboundChannelResult(tenantId, channel.key, {
            message: formatFailureMessage(result.reason),
            at: new Date(),
          });
        } else if (hadPriorFailure) {
          // 前回失敗が記録されている状態から今回は成功したので、警告表示をクリアする
          await repos.tenants.recordOutboundChannelResult(tenantId, channel.key, null);
        }
      } catch (err) {
        // 記録自体の失敗はログに残すだけで、通知送信自体の成否判定には影響させない
        console.error(`[outbound-notify] ${channel.name} の送信結果記録に失敗しました:`, err);
      }
    }),
  );
}

// 指定チャネルの直近失敗が記録済みかどうかを判定する (成功時の不要な DB 書き込みを避けるための判定専用)
function channelHasRecordedFailure(
  tenant: Pick<Tenant, 'slackLastFailureAt' | 'teamsLastFailureAt' | 'chatworkLastFailureAt'>,
  channel: OutboundChannelKey,
): boolean {
  // CHANNEL_FAILURE_AT_FIELD でチャネルキーを対応する Tenant のフィールド名に変換する
  const fieldName = CHANNEL_FAILURE_AT_FIELD[channel];
  // そのフィールドが null/undefined でなければ「失敗記録あり」と判定する
  return tenant[fieldName] != null;
}

// Promise.allSettled の reason (拒否理由) を、管理画面に表示できる安全な文字列に変換する。
// - Error インスタンスなら message だけを使う (スタックトレース等の内部詳細は含めない)
// - Error 以外 (将来 Notifier 実装が非 Error を reject した場合の保険) は String() にフォールバックする
// - サロゲートペア (絵文字等) の途中で文字列を切らないよう、コードポイント単位で切り詰める
function formatFailureMessage(reason: unknown): string {
  // Error インスタンスなら message を、そうでなければ文字列化した値を使う
  const raw = reason instanceof Error ? reason.message : String(reason);
  // Array.from はコードポイント単位で分割するため、.slice() と違いサロゲートペアを壊さない
  return Array.from(raw).slice(0, FAILURE_MESSAGE_MAX_LENGTH).join('');
}

// tenantId + 呼び出し元コンテキストを受け取り、ベース URL 解決 + 送信 + ベストエフォート
// エラーハンドリングをまとめる共通ヘルパー。担当者アサイン変更・CSV インポートのように
// 「ベース URL を解決してメッセージを組み立て、失敗はログのみに留める」形が繰り返し
// 現れる箇所で使う (§6 DRY)。メッセージ本文はベース URL 依存 (ticketUrl) のことが多いため、
// buildMessage にベース URL を渡してその場で組み立ててもらう。
export async function notifyOutboundBestEffort(
  tenantId: string, // 送信先テナント
  buildMessage: (baseUrl: string) => OutboundMessage, // ベース URL を使ってメッセージを組み立てる関数
  logContext: string, // エラーログの接頭辞 (呼び出し元を識別するため。例: '[updateTicketAssignee]')
): Promise<void> {
  try {
    // ベース URL を取得する (NEXTAUTH_URL 未設定時に例外が出る可能性があるため内側に置く)
    const baseUrl = resolveAppBaseUrl();
    // 呼び出し元が組み立てたメッセージを外部チャネルへ送る
    await sendOutboundNotification(tenantId, buildMessage(baseUrl));
  } catch (err) {
    // 外部通知の失敗はログに記録するが、呼び出し元の処理自体は成功扱いにする
    // (ネットワーク障害・Webhook 設定ミスで本来の操作が失敗に見えるのを防ぐ)
    console.error(`${logContext} 外部通知の送信に失敗しました (処理自体は完了):`, err);
  }
}

// 新規チケット作成を Slack/Teams/Chatwork の外部チャネルへ通知する共通ヘルパー。
// Phase 4「Slack / Chatwork / Microsoft Teams 通知 Adapter」の主目的である
// 「新しい問い合わせが届いたことにすぐ気づける」を、起票チャネル (Web フォーム / メール取り込み /
// LINE 連携 / CSV インポート) を問わず満たすため、チケットを作成する全ての入口から呼ぶ。
// 送信失敗はログに残すだけで呼び出し元のチケット作成処理には影響させない (非クリティカルな副作用)。
export async function notifyNewTicketOutbound(
  tenantId: string,
  ticket: NewTicketNotifyInput,
): Promise<void> {
  try {
    // ベース URL を取得してチケットリンクを組み立てる (NEXTAUTH_URL 未設定時に例外が出る可能性があるため内側に置く)
    const baseUrl = resolveAppBaseUrl();
    // 外部チャネル (Slack/Teams/Chatwork) に通知を送る
    await sendOutboundNotification(tenantId, {
      subject: `新しい問い合わせが届きました: ${ticket.title}`,
      body: `優先度: ${PRIORITY_LABELS[ticket.priority] ?? ticket.priority}`,
      ticketUrl: `${baseUrl}/tickets/${ticket.id}`,
    });
  } catch (err) {
    // 外部通知の失敗はログに記録するが、呼び出し元のチケット作成自体は成功扱いにする
    // (ネットワーク障害・Webhook 設定ミスでチケット起票が失敗に見えるのを防ぐ)
    console.error(
      '[notifyNewTicketOutbound] 外部通知の送信に失敗しました (チケット作成は完了):',
      err,
    );
  }
}
