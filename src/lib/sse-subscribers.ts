/**
 * Thin facade over the `NotificationBroadcaster` port.
 *
 * Historic call sites (SSE route handler, Server Actions) keep importing
 * `addSubscriber` / `removeSubscriber` / `broadcast` from this module. The
 * actual registry lives in `@/data` and can be swapped to a Redis / Postgres
 * `LISTEN/NOTIFY` adapter without touching these call sites.
 *
 * Tracking: see GitHub issue #60.
 */

// 通知配信の実体 (NotificationBroadcaster) をデータ層から読み込む
import { notificationBroadcaster } from '@/data';

// SSE (Server-Sent Events) で使うレスポンスコントローラーの型エイリアス
export type Controller = ReadableStreamDefaultController<Uint8Array>;

// 指定ユーザーの購読 (SSE 接続) を登録する関数
export function addSubscriber(userId: string, controller: Controller): void {
  // 下位実装 (notificationBroadcaster) に処理を委譲
  notificationBroadcaster.addSubscriber(userId, controller);
}

// 指定ユーザーの購読を解除する関数 (接続切断時などに呼ぶ)
export function removeSubscriber(userId: string, controller: Controller): void {
  // 下位実装に処理を委譲
  notificationBroadcaster.removeSubscriber(userId, controller);
}

// 指定ユーザーの全 SSE 接続に未読件数 (count) を送信する関数
export function broadcast(userId: string, count: number): void {
  // 下位実装に処理を委譲
  notificationBroadcaster.broadcast(userId, count);
}
