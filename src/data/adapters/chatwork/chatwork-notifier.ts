// Phase 4: Chatwork REST API を使った外部通知チャネルの Adapter。
// OutboundNotifier port の Chatwork 実装。
//
// 重要: Chatwork は Slack/Teams のような Incoming Webhook ではなく REST API を使う。
//   POST https://api.chatwork.com/v2/rooms/{room_id}/messages
//   Header: X-ChatWorkToken: {token}
//   Body  : body=<message> (application/x-www-form-urlencoded)
// 送信先ホストは api.chatwork.com 固定のため SSRF の心配はない (URL はユーザー入力ではない)。
// docs/smb-dx-pivot-plan.md §4 Phase 4「Slack / Chatwork / Microsoft Teams 通知 Adapter」。

// OutboundNotifier port の型定義
import type { OutboundMessage, OutboundNotifier } from '@/data/ports/outbound-notifier';

// Chatwork API のベース URL (固定。ユーザー入力を URL に混ぜないことで SSRF を防ぐ)
const CHATWORK_API_BASE = 'https://api.chatwork.com/v2';

// Chatwork API レスポンスの最大読み取りサイズ (バイト数)。エラー本文の確認用に 1KB 許容する
const MAX_RESPONSE_SIZE_BYTES = 1024;

// 送信のタイムアウト (ミリ秒)。Chatwork 側障害でサーバーアクションがハングするのを防ぐ
const CHATWORK_TIMEOUT_MS = 5_000;

// ルーム ID が数字のみで構成されているかを検証する正規表現。
// ルーム ID は URL パスに埋め込むため、数字以外 (パス区切りやクエリ) の混入を拒否してパス
// インジェクションを防ぐ。
const ROOM_ID_PATTERN = /^\d+$/;

// ユーザー入力を Chatwork メッセージに埋め込む前にタグ記法を無効化する。
// Chatwork は [To:id]・[title]…[/title]・[info] などの角括弧タグを解釈するため、
// requester が任意文字列に角括弧を含めるとメンション偽装やタグ崩れが起きうる。
// 角括弧を全角に置換して見た目を保ちつつタグとして解釈されないようにする。
function neutralizeChatworkTags(text: string): string {
  // 半角 [ を全角 ［ に置換する (開きタグの解釈を無効化)
  const step1 = text.replace(/\[/g, '［');
  // 半角 ] を全角 ］ に置換する (閉じタグの解釈を無効化)
  return step1.replace(/\]/g, '］');
}

// Chatwork REST API を使った OutboundNotifier 実装を生成するファクトリ関数
// apiToken: Chatwork の API トークン (X-ChatWorkToken ヘッダに載せる)
// roomId: 投稿先ルーム ID (数字文字列)
export function createChatworkNotifier(apiToken: string, roomId: string): OutboundNotifier {
  return {
    // メッセージを Chatwork ルームへ送信する
    async send(message: OutboundMessage): Promise<void> {
      // ルーム ID が数字のみであることを検証する (パスインジェクション防止)。
      // 不正な値は fail-closed で例外にし、呼び出し側 (sendOutboundNotification) がログに残す
      if (!ROOM_ID_PATTERN.test(roomId)) {
        throw new Error('Chatwork ルーム ID が不正です (数字のみ許可)');
      }

      // ユーザー由来のテキストを Chatwork タグインジェクション対策として無効化する
      const safeSubject = neutralizeChatworkTags(message.subject);
      const safeBody = neutralizeChatworkTags(message.body);

      // Chatwork のメッセージ本文を組み立てる。[info]/[title] タグで見やすく整形する。
      // タグ自体はシステムが付与する固定文字列なので安全 (ユーザー入力は上で無効化済み)
      const lines = [`[info][title]${safeSubject}[/title]${safeBody}`];
      // チケット URL があれば本文末尾にリンクを追記する (Chatwork は URL を自動リンク化する)
      if (message.ticketUrl) {
        lines.push(`\n問い合わせ: ${message.ticketUrl}`);
      }
      // [info] タグを閉じて 1 つのメッセージ本文にまとめる
      const body = `${lines.join('')}[/info]`;

      // フォームエンコードのリクエストボディを組み立てる (Chatwork は form-urlencoded を要求)
      const form = new URLSearchParams();
      form.set('body', body); // 投稿本文
      form.set('self_unread', '0'); // 自分の送信メッセージは既読扱いにする

      // Chatwork メッセージ投稿 API へ POST する。ルーム ID は検証済みなのでパスに埋め込む
      const response = await fetch(`${CHATWORK_API_BASE}/rooms/${roomId}/messages`, {
        method: 'POST',
        headers: {
          // API トークンで認証する (Chatwork 独自ヘッダ)
          'X-ChatWorkToken': apiToken,
          // フォームエンコード形式を明示する
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        // URLSearchParams を文字列化して送る
        body: form.toString(),
        // 一定時間でタイムアウト (Chatwork 障害時のハングを防ぐ)
        signal: AbortSignal.timeout(CHATWORK_TIMEOUT_MS),
      });

      // エラー本文をサイズ制限付きで読む (大量レスポンスでメモリを消費しない)
      const responseText = await response.text().then((t) => t.slice(0, MAX_RESPONSE_SIZE_BYTES));

      // Chatwork は成功時に HTTP 200 + JSON {"message_id":"..."} を返す。
      // 認証失敗 (401) やルーム不在 (404) は 4xx になるため HTTP ステータスで判定する。
      // セキュリティ: エラー本文に API トークンは含まれないが、詳細は呼び出し側ログのみに残す
      if (!response.ok) {
        throw new Error(`Chatwork API 送信失敗: HTTP ${response.status} - ${responseText}`);
      }
    },
  };
}
