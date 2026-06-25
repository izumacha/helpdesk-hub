// Phase 4: Slack Incoming Webhook を使った外部通知チャネルの Adapter。
// OutboundNotifier port の Slack 実装。Teams も Incoming Webhook 形式が類似しているため
// 同じ Adapter で対応可能 (URL を Teams の Webhook URL に設定するだけで動く)。
// docs/smb-dx-pivot-plan.md §4 Phase 4「Slack / Chatwork / Microsoft Teams 通知 Adapter」。

// OutboundNotifier port の型定義
import type { OutboundMessage, OutboundNotifier } from '@/data/ports/outbound-notifier';
// Webhook POST 共通ユーティリティ (タイムアウト・本文上限・リダイレクト非追従の SSRF 防御)
import { postWebhook } from '@/lib/webhook-fetch';

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

// Webhook 送信のタイムアウト (ミリ秒)。Slack 側障害でサーバーアクションがハングするのを防ぐ
const SLACK_TIMEOUT_MS = 5_000;

// ユーザー入力を Slack mrkdwn に埋め込む前にエスケープする。
// Slack mrkdwn では < URL|ラベル > 記法がクリッカブルリンクとして解釈されるため、
// ユーザー由来の < と > を HTML エンティティに変換してインジェクションを防ぐ。
// エスケープ順序: & を先に変換しないと &lt; の & が再変換されて二重エンコードになる。
function escapeMrkdwn(text: string): string {
  // & → &amp; (必ず最初に変換する)
  const step1 = text.replace(/&/g, '&amp;');
  // < → &lt; (リンク記法の開き括弧を無効化)
  const step2 = step1.replace(/</g, '&lt;');
  // > → &gt; (リンク記法の閉じ括弧を無効化)
  return step2.replace(/>/g, '&gt;');
}

// Slack / Teams Incoming Webhook を使った OutboundNotifier 実装を生成するファクトリ関数
// webhookUrl: Slack または Teams の Incoming Webhook URL
export function createSlackNotifier(webhookUrl: string): OutboundNotifier {
  return {
    // メッセージを Slack / Teams へ送信する
    async send(message: OutboundMessage): Promise<void> {
      // ユーザー由来のテキストを mrkdwn インジェクション対策としてエスケープする。
      // チケットタイトル (subject) や本文 (body) には requester が任意の文字列を入力できるため、
      // < URL|ラベル > 形式のフィッシングリンクが Slack チャネルに表示されるのを防ぐ。
      const safeSubject = escapeMrkdwn(message.subject);
      const safeBody = escapeMrkdwn(message.body);

      // Slack Block Kit でリッチなメッセージを構築する。
      // フォールバック用 text と blocks の両方を送り、クライアントが blocks 非対応でも読める。
      const blocks: SlackBlock[] = [
        {
          // 件名をボールドヘッダーとして表示 (mrkdwn で *...* を使う; 中身はエスケープ済み)
          type: 'section',
          text: { type: 'mrkdwn', text: `*${safeSubject}*` },
        },
        {
          // 区切り線で件名と本文を分ける
          type: 'divider',
        },
        {
          // 本文をプレーンテキストで表示 (エスケープ済みのためリンクは埋め込まれない)
          type: 'section',
          text: { type: 'mrkdwn', text: safeBody },
        },
      ];

      // チケット URL が指定されている場合はリンクを追加する (Slack mrkdwn の <URL|ラベル> 記法)
      // ticketUrl はシステム生成値 (baseUrl + ticketId) のため、ユーザー入力ではなくエスケープ不要
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
        // blocks 非対応クライアント向けのフォールバックテキスト (エスケープ済みを使う)
        text: `[HelpDesk Hub] ${safeSubject}\n${safeBody}`,
        blocks,
      };

      // Incoming Webhook エンドポイントへ POST 送信する。
      // 共通ヘルパーがタイムアウト・本文上限読み取り・リダイレクト非追従 (SSRF 防御) を担う。
      const { ok, status, bodyText } = await postWebhook(webhookUrl, {
        // Slack Incoming Webhook は Content-Type: application/json を要求する
        headers: { 'Content-Type': 'application/json' },
        // JSON 文字列化したペイロードを送信する
        body: JSON.stringify(payload),
        // 一定時間でタイムアウト (Slack 障害時のハングを防ぐ)
        timeoutMs: SLACK_TIMEOUT_MS,
        // レスポンス本文の読み取り上限
        maxResponseBytes: MAX_RESPONSE_SIZE_BYTES,
      });

      // HTTP レベルのエラー (4xx / 5xx) をチェックする
      if (!ok) {
        // 内部エラーとして throw (呼び出し側が catch してログ記録 or 握りつぶす)
        throw new Error(`Slack Webhook 送信失敗: HTTP ${status} - ${bodyText}`);
      }

      // Slack は HTTP 200 でもアプリレベルエラー ("no_service", "invalid_payload" 等) を返すことがある。
      // 成功時のボディは "ok" のみなので、それ以外はエラーとして扱う
      if (bodyText.trim() !== 'ok') {
        throw new Error(`Slack Webhook 送信失敗: ${bodyText}`);
      }
    },
  };
}
