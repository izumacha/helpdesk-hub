// Phase 4: Slack Incoming Webhook を使った外部通知チャネルの Adapter。
// OutboundNotifier port の Slack 実装。Teams も Incoming Webhook 形式が類似しているため
// 同じ Adapter で対応可能 (URL を Teams の Webhook URL に設定するだけで動く)。
// docs/smb-dx-pivot-plan.md §4 Phase 4「Slack / Chatwork / Microsoft Teams 通知 Adapter」。

// OutboundNotifier port の型定義
import type { OutboundMessage, OutboundNotifier } from '@/data/ports/outbound-notifier';

// Slack Incoming Webhook のペイロード型 (公開 API の最小限の定義)
// ドキュメント: https://api.slack.com/messaging/webhooks
interface SlackPayload {
  // 投稿するメッセージ本文 (mrkdwn 形式)
  text: string;
  // 構造化ブロック (ボタン・区切り線など視覚的要素に使う)
  blocks?: SlackBlock[];
}

// Slack Block Kit のブロック型 (Section と Divider のみ使用)
interface SlackBlock {
  // ブロック種別 ("section" | "divider" など)
  type: string;
  // テキスト要素 (Section ブロックに使う)
  text?: { type: string; text: string };
}

// Slack Webhook レスポンスの最大ボディサイズ (バイト数)。
// Slack は成功時 "ok" (2 バイト) を返すが、念のため 1KB まで許容する
const MAX_RESPONSE_SIZE_BYTES = 1024;

// Slack / Teams Incoming Webhook を使った OutboundNotifier 実装を生成するファクトリ関数
// webhookUrl: Slack または Teams の Incoming Webhook URL
export function createSlackNotifier(webhookUrl: string): OutboundNotifier {
  return {
    // メッセージを Slack / Teams へ送信する
    async send(message: OutboundMessage): Promise<void> {
      // Slack Block Kit でリッチなメッセージを構築する。
      // フォールバック用 text と blocks の両方を送り、クライアントが blocks 非対応でも読める。
      const blocks: SlackBlock[] = [
        {
          // 件名をボールドヘッダーとして表示 (mrkdwn で *...* を使う)
          type: 'section',
          text: { type: 'mrkdwn', text: `*${message.subject}*` },
        },
        {
          // 区切り線で件名と本文を分ける
          type: 'divider',
        },
        {
          // 本文をプレーンテキストで表示
          type: 'section',
          text: { type: 'mrkdwn', text: message.body },
        },
      ];

      // チケット URL が指定されている場合はリンクを追加する (Slack mrkdwn の <URL|ラベル> 記法)
      if (message.ticketUrl) {
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `<${message.ticketUrl}|問い合わせを確認する →>`,
          },
        });
      }

      // Slack Incoming Webhook のペイロードを組み立てる
      const payload: SlackPayload = {
        // blocks 非対応クライアント向けのフォールバックテキスト
        text: `[HelpDesk Hub] ${message.subject}\n${message.body}`,
        blocks,
      };

      // Incoming Webhook エンドポイントへ POST 送信する。
      // AbortSignal.timeout で 5 秒以内にレスポンスが来なければ AbortError を throw する
      // (Slack 障害時にサーバーアクションが無限にハングするのを防ぐ)
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          // Slack Incoming Webhook は Content-Type: application/json を要求する
          'Content-Type': 'application/json',
        },
        // JSON 文字列化したペイロードを送信する
        body: JSON.stringify(payload),
        // 5 秒でタイムアウト (Slack 障害時のハングを防ぐ)
        signal: AbortSignal.timeout(5_000),
      });

      // レスポンスボディをサイズ制限付きで読む (大量のレスポンスでメモリを消費しない)
      const responseText = await response.text().then((t) => t.slice(0, MAX_RESPONSE_SIZE_BYTES));

      // HTTP レベルのエラー (4xx / 5xx) をチェックする
      if (!response.ok) {
        // 内部エラーとして throw (呼び出し側が catch してログ記録 or 握りつぶす)
        throw new Error(
          `Slack Webhook 送信失敗: HTTP ${response.status} - ${responseText}`,
        );
      }

      // Slack は HTTP 200 でもアプリレベルエラー ("no_service", "invalid_payload" 等) を返すことがある。
      // 成功時のボディは "ok" のみなので、それ以外はエラーとして扱う
      if (responseText.trim() !== 'ok') {
        throw new Error(`Slack Webhook 送信失敗: ${responseText}`);
      }
    },
  };
}
