/**
 * チケット機能の共有型定義。
 *
 * 'use client' を持つコンポーネントから切り出すことで、
 * サーバー側の純粋関数 (tab-filter.ts / build-filter.ts) が
 * クライアントコンポーネントに依存しない構造にする。
 */

// 一覧タブの識別子型 (URL クエリ ?tab=... と対応する値)
// - 'all'     : 既定 (絞り込みなし、全件)
// - 'mine'    : 自分の未対応 (担当者または起票者として Open / InProgress)
// - 'overdue' : 期限切れ (resolutionDueAt < now かつ未解決)
export type TicketTabId = 'all' | 'mine' | 'overdue';
