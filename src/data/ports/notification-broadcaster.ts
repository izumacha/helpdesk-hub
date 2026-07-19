// Port: 通知ブロードキャスター。
// 未読件数 SSE イベントを接続中クライアントへ届ける処理を抽象化する。
// SSE ルートハンドラと Server Action はこのポートにのみ依存し、
// 具体的な実装 (in-memory Map, Redis pub/sub, Postgres LISTEN/NOTIFY 等) には依存しない。
// 追跡: GitHub issue #60。

// SSE 接続 1 本分を表すコントローラー型 (Web 標準 ReadableStream のコントローラー)
export type BroadcastController = ReadableStreamDefaultController<Uint8Array>;

// 通知ブロードキャスタの契約 (port)
// 実装は in-memory Map だったり、将来的には Redis pub/sub だったりする
export interface NotificationBroadcaster {
  addSubscriber(userId: string, controller: BroadcastController): void; // ユーザーの SSE 接続を登録
  removeSubscriber(userId: string, controller: BroadcastController): void; // 接続を解除
  broadcast(userId: string, count: number): void; // 指定ユーザーの全接続に未読件数を送信
  // フォローアップ (監査で発見したギャップ): GET /api/notifications/stream は新規接続確立の
  // *頻度* しかレート制限しておらず、同時に張れる接続数そのものには上限が無かった
  // (ルートハンドラのコメントに残っていた既知の未対応課題)。呼び出し元 (route.ts) がストリームを
  // 開く前にこの値を見て上限判定できるよう、現在の同時接続数を返す
  getSubscriberCount(userId: string): number;
}
