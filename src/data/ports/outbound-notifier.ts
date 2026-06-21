// Port: 外部通知チャネル (Slack / Teams など) への送信契約。
// Phase 4 Slack 通知 Adapter の基盤。実装を差し替えても呼び出し側は変わらない。
// docs/smb-dx-pivot-plan.md §5.4「通知チャネルの Adapter 化」に対応する。

// 外部チャネルへ送信する通知メッセージの型
export interface OutboundMessage {
  // メッセージの件名 (Slack ではボールドヘッダーとして使う)
  subject: string;
  // メッセージ本文 (チケットタイトルや変更内容など)
  body: string;
  // 関連チケットへの URL (クリックしてアプリに飛べるリンク。省略可)
  ticketUrl?: string;
}

// 外部通知チャネルの送信契約 (port)
// 実装は Slack Incoming Webhook / Teams Incoming Webhook / Chatwork API など多岐にわたる
export interface OutboundNotifier {
  // メッセージを外部チャネルへ送信する。失敗時は例外を throw する
  send(message: OutboundMessage): Promise<void>;
}
