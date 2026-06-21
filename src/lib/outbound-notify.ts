// Phase 4: 外部通知チャネル (Slack / Teams) への送信ヘルパー。
// テナントの slackWebhookUrl を見て、設定済みの場合だけ送信する。
// 送信失敗はログに残すが、チケット操作自体は止めない (non-critical なサイドエフェクト)。
// docs/smb-dx-pivot-plan.md §5.4「notify:slack (新規、最重要)」に対応する。

// Slack Adapter のファクトリ関数
import { createSlackNotifier } from '@/data/adapters/slack/slack-notifier';
// 送信メッセージ型
import type { OutboundMessage } from '@/data/ports/outbound-notifier';
// テナント情報取得 (slackWebhookUrl の参照)
import { repos } from '@/data';

// 指定テナントの外部通知チャネルにメッセージを送信する
// - slackWebhookUrl が null なら何もしない (通知無効の正常系)
// - 送信失敗はコンソールエラーに留め、呼び出し元 (Server Action) を止めない
export async function sendOutboundNotification(
  tenantId: string,
  message: OutboundMessage,
): Promise<void> {
  // テナント情報を取得して slackWebhookUrl を確認する
  const tenant = await repos.tenants.findById(tenantId);
  // slackWebhookUrl が未設定なら送信しない (正常終了)
  if (!tenant?.slackWebhookUrl) return;

  // Slack Adapter を生成してメッセージを送信する
  const notifier = createSlackNotifier(tenant.slackWebhookUrl);
  try {
    // 実際に Slack / Teams へ POST する
    await notifier.send(message);
  } catch (err) {
    // 外部 Webhook の失敗はチケット操作の成否に影響させない
    // (Webhook URL の誤り・Slack 側の障害などは利用者の問い合わせ受付を止めるべきでない)
    // セキュリティ: err の詳細はサーバーログのみに残し、レスポンスには含めない
    console.error('[outbound-notify] Slack/Teams 通知の送信に失敗しました:', err);
  }
}
