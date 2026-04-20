// チケット状態型をインポート
import type { TicketStatus } from '@/generated/prisma';

// FAQ 候補化を許可するチケット状態一覧 (解決済みのみ候補化可能)
export const FAQ_ELIGIBLE_STATUSES: readonly TicketStatus[] = ['Resolved'];

// チケット状態の英語キーに対応する日本語表示ラベル
export const STATUS_LABELS: Record<string, string> = {
  New: '新規',
  Open: 'オープン',
  WaitingForUser: 'ユーザー待ち',
  InProgress: '対応中',
  Escalated: 'エスカレーション',
  Resolved: '解決済み',
  Closed: 'クローズ',
};

// 優先度キーに対応する日本語表示ラベル
export const PRIORITY_LABELS: Record<string, string> = {
  Low: '低',
  Medium: '中',
  High: '高',
};

// 状態ごとのバッジ配色 (Tailwind CSS クラス)
export const STATUS_COLORS: Record<string, string> = {
  New: 'bg-gray-100 text-gray-700', // 新規: 灰色系
  Open: 'bg-blue-100 text-blue-700', // オープン: 青系
  WaitingForUser: 'bg-yellow-100 text-yellow-700', // ユーザー待ち: 黄系
  InProgress: 'bg-indigo-100 text-indigo-700', // 対応中: 藍系
  Escalated: 'bg-red-100 text-red-700', // エスカレーション: 赤系
  Resolved: 'bg-green-100 text-green-700', // 解決済み: 緑系
  Closed: 'bg-gray-100 text-gray-500', // クローズ: 薄い灰色
};

// 優先度ごとの文字色クラス (Tailwind CSS)
export const PRIORITY_COLORS: Record<string, string> = {
  Low: 'text-gray-500', // 低: グレー
  Medium: 'text-yellow-600', // 中: 黄色
  High: 'text-red-600 font-semibold', // 高: 赤 + 太字
};

// FAQ 状態キーに対応する日本語表示ラベル
export const FAQ_STATUS_LABELS: Record<string, string> = {
  Candidate: '候補',
  Published: '公開済み',
  Rejected: '却下',
};

// FAQ 状態ごとのバッジ配色 (Tailwind CSS クラス)
export const FAQ_STATUS_COLORS: Record<string, string> = {
  Candidate: 'bg-yellow-100 text-yellow-700', // 候補: 黄系
  Published: 'bg-green-100 text-green-700', // 公開済み: 緑系
  Rejected: 'bg-gray-100 text-gray-500', // 却下: 灰色系
};

// 履歴項目の英語キーに対応する日本語表示ラベル
export const HISTORY_FIELD_LABELS: Record<string, string> = {
  status: 'ステータス',
  priority: '優先度',
  assignee: '担当者',
  escalation: 'エスカレーション',
};

// 通知種別の英語キーに対応する日本語表示ラベル
export const NOTIFICATION_TYPE_LABELS: Record<string, string> = {
  assigned: '担当割当',
  escalated: 'エスカレーション',
  commented: 'コメント',
  statusChanged: 'ステータス変更',
};
