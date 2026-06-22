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

// 設定済みチャネルを表す内部型 (ログ用のチャネル名と送信実体をペアで持つ)
interface ResolvedChannel {
  name: string; // ログ表示用のチャネル名 (Slack / Teams / Chatwork)
  notifier: OutboundNotifier; // 実際の送信を行う Adapter
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
  // slackWebhookUrl が設定済みかつ SSRF 安全なら Slack チャネルを追加する。
  // SSRF 二重防御: 保存時 (update-notification-channels.ts) に検証済みだが、
  // DNS リバインディング攻撃 (登録時はパブリック IP → 後に内部 IP に変更) を緩和するため
  // 送信直前にもリテラル IP パターンを再検証する。
  if (tenant.slackWebhookUrl) {
    if (isUnsafeUrl(tenant.slackWebhookUrl)) {
      // 安全でない URL が DB に残っている場合はスキップしてエラーをログに残す
      console.error('[outbound-notify] SSRF ガード: 安全でない Slack Webhook URL をスキップしました');
    } else {
      channels.push({ name: 'Slack', notifier: createSlackNotifier(tenant.slackWebhookUrl) });
    }
  }

  // ── Teams ───────────────────────────────────────────────────────────────────
  // teamsWebhookUrl が設定済みかつ SSRF 安全なら Teams チャネルを追加する (Slack と同様の二重防御)
  if (tenant.teamsWebhookUrl) {
    if (isUnsafeUrl(tenant.teamsWebhookUrl)) {
      console.error('[outbound-notify] SSRF ガード: 安全でない Teams Webhook URL をスキップしました');
    } else {
      channels.push({ name: 'Teams', notifier: createTeamsNotifier(tenant.teamsWebhookUrl) });
    }
  }

  // ── Chatwork ──────────────────────────────────────────────────────────────────
  // API トークンとルーム ID の両方が揃っているときだけ Chatwork チャネルを追加する。
  // 送信先ホストは api.chatwork.com 固定 (ユーザー入力ではない) のため SSRF 検証は不要。
  if (tenant.chatworkApiToken && tenant.chatworkRoomId) {
    channels.push({
      name: 'Chatwork',
      notifier: createChatworkNotifier(tenant.chatworkApiToken, tenant.chatworkRoomId),
    });
  }

  // 設定済みチャネルが 1 つも無ければ送信しない (正常終了)
  if (channels.length === 0) return;

  // 全チャネルへ並行送信する。1 つが失敗しても他チャネルの送信は止めない (allSettled)
  const results = await Promise.allSettled(channels.map((c) => c.notifier.send(message)));

  // 失敗したチャネルだけをログに残す (チケット操作の成否には影響させない)
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      // どのチャネルで失敗したかを明示してログに残す。
      // セキュリティ: reason の詳細はサーバーログのみに残し、レスポンスには含めない
      console.error(
        `[outbound-notify] ${channels[index].name} 通知の送信に失敗しました:`,
        result.reason,
      );
    }
  });
}
