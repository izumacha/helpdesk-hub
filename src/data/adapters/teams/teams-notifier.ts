// Phase 4: Microsoft Teams Incoming Webhook を使った外部通知チャネルの Adapter。
// OutboundNotifier port の Teams 実装。
//
// 重要: Teams は Slack とペイロード形式が異なる。Slack の { text, blocks } は Teams では
// 描画されないため、Teams 用の Adaptive Card (application/vnd.microsoft.card.adaptive) を送る。
// また Teams は成功時に空ボディ + HTTP 200/202 を返すため、Slack のような "ok" 判定はできない。
// docs/smb-dx-pivot-plan.md §4 Phase 4「Slack / Chatwork / Microsoft Teams 通知 Adapter」。

// OutboundNotifier port の型定義
import type { OutboundMessage, OutboundNotifier } from '@/data/ports/outbound-notifier';
// Webhook POST 共通ユーティリティ (タイムアウト・本文上限・リダイレクト非追従の SSRF 防御)
import { postWebhook } from '@/lib/webhook-fetch';

// Teams Webhook レスポンスの最大読み取りサイズ (バイト数)。
// Teams は成功時に "1" や空文字を返すが、エラー時の本文を読むため 1KB まで許容する
const MAX_RESPONSE_SIZE_BYTES = 1024;

// Webhook 送信のタイムアウト (ミリ秒)。Teams 側障害でサーバーアクションがハングするのを防ぐ
const TEAMS_TIMEOUT_MS = 5_000;

// Adaptive Card のスキーマ URL (Teams が要求する固定値)
const ADAPTIVE_CARD_SCHEMA = 'http://adaptivecards.io/schemas/adaptive-card.json';

// ユーザー入力を Adaptive Card の TextBlock に埋め込む前に無害化する。
// Teams の TextBlock は既定で Markdown のサブセット (リンク [x](y) 等) を解釈する。
// チケットタイトルや本文には requester が任意文字列を入力できるため、Markdown のリンク記法で
// フィッシングリンクが表示されるのを防ぐ。バックスラッシュエスケープ (\[ 等) は Teams の
// クライアントによっては尊重されないため、角括弧を全角に置換して確実にリンク記法を無効化する
// (Chatwork アダプタと同じ方針。クライアントの Markdown 描画挙動に依存しない)。
function neutralizeTeamsMarkdown(text: string): string {
  // 半角 [ を全角 ［ に置換する (Markdown リンク/画像の開き括弧を無効化)
  const step1 = text.replace(/\[/g, '［');
  // 半角 ] を全角 ］ に置換する (閉じ括弧を無効化し [label](url) を成立させない)
  return step1.replace(/\]/g, '］');
}

// Microsoft Teams Incoming Webhook を使った OutboundNotifier 実装を生成するファクトリ関数
// webhookUrl: Teams (Power Automate / Workflows) の Incoming Webhook URL
export function createTeamsNotifier(webhookUrl: string): OutboundNotifier {
  return {
    // メッセージを Teams へ送信する
    async send(message: OutboundMessage): Promise<void> {
      // ユーザー由来のテキストを Markdown インジェクション対策として無害化する
      const safeSubject = neutralizeTeamsMarkdown(message.subject);
      const safeBody = neutralizeTeamsMarkdown(message.body);

      // Adaptive Card の本文ブロックを組み立てる (件名を見出し・本文を通常テキストで表示)
      const cardBody: Array<Record<string, unknown>> = [
        {
          // 件名を大きめのボールド見出しとして表示する
          type: 'TextBlock',
          text: safeSubject,
          weight: 'Bolder',
          size: 'Large',
          wrap: true, // 長い件名を折り返す
        },
        {
          // 本文を通常テキストで表示する (折り返しあり)
          type: 'TextBlock',
          text: safeBody,
          wrap: true,
        },
      ];

      // Adaptive Card のアクション (ボタン) を組み立てる。チケット URL があればリンクボタンを足す
      // ticketUrl はシステム生成値 (baseUrl + ticketId) のためエスケープ不要
      const actions: Array<Record<string, unknown>> = [];
      if (message.ticketUrl) {
        actions.push({
          type: 'Action.OpenUrl', // 押すとブラウザでチケットを開く
          title: '問い合わせを確認する',
          url: message.ticketUrl,
        });
      }

      // Teams が要求する attachments 形式で Adaptive Card をラップしたペイロードを組み立てる
      const payload = {
        type: 'message',
        attachments: [
          {
            // Adaptive Card であることを示す固定の contentType
            contentType: 'application/vnd.microsoft.card.adaptive',
            content: {
              $schema: ADAPTIVE_CARD_SCHEMA, // Adaptive Card スキーマ URL
              type: 'AdaptiveCard',
              version: '1.4', // Teams が安定対応する Adaptive Card バージョン
              body: cardBody, // 件名・本文ブロック
              // アクションが 1 件以上あるときだけ actions を含める
              ...(actions.length > 0 ? { actions } : {}),
            },
          },
        ],
      };

      // Teams Incoming Webhook エンドポイントへ POST する。
      // Teams Incoming Webhook へ POST する。
      // 共通ヘルパーがタイムアウト・本文上限読み取り・リダイレクト非追従 (SSRF 防御) を担う。
      const { ok, status, bodyText } = await postWebhook(webhookUrl, {
        // Teams Webhook は JSON ボディを要求する
        headers: { 'Content-Type': 'application/json' },
        // JSON 文字列化したペイロードを送信する
        body: JSON.stringify(payload),
        // 一定時間でタイムアウト (Teams 障害時のハングを防ぐ)
        timeoutMs: TEAMS_TIMEOUT_MS,
        // レスポンス本文の読み取り上限
        maxResponseBytes: MAX_RESPONSE_SIZE_BYTES,
      });

      // Teams は成功時に HTTP 200/202 を返す (本文は空 or "1")。
      // Slack のような "ok" 文字列判定はできないため、HTTP ステータスで成否を判定する
      if (!ok) {
        // 内部エラーとして throw (呼び出し側が catch してログ記録 or 握りつぶす)
        throw new Error(`Teams Webhook 送信失敗: HTTP ${status} - ${bodyText}`);
      }
    },
  };
}
