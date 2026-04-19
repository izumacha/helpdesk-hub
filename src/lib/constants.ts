import type { TicketStatus } from '@/generated/prisma';

export const FAQ_ELIGIBLE_STATUSES: readonly TicketStatus[] = ['Resolved'];

export const STATUS_LABELS: Record<string, string> = {
  New: '新規',
  Open: 'オープン',
  WaitingForUser: 'ユーザー待ち',
  InProgress: '対応中',
  Escalated: 'エスカレーション',
  Resolved: '解決済み',
  Closed: 'クローズ',
};

export const PRIORITY_LABELS: Record<string, string> = {
  Low: '低',
  Medium: '中',
  High: '高',
};

export const STATUS_COLORS: Record<string, string> = {
  New: 'bg-gray-100 text-gray-700',
  Open: 'bg-blue-100 text-blue-700',
  WaitingForUser: 'bg-yellow-100 text-yellow-700',
  InProgress: 'bg-indigo-100 text-indigo-700',
  Escalated: 'bg-red-100 text-red-700',
  Resolved: 'bg-green-100 text-green-700',
  Closed: 'bg-gray-100 text-gray-500',
};

export const PRIORITY_COLORS: Record<string, string> = {
  Low: 'text-gray-500',
  Medium: 'text-yellow-600',
  High: 'text-red-600 font-semibold',
};

export const FAQ_STATUS_LABELS: Record<string, string> = {
  Candidate: '候補',
  Published: '公開済み',
  Rejected: '却下',
};

export const FAQ_STATUS_COLORS: Record<string, string> = {
  Candidate: 'bg-yellow-100 text-yellow-700',
  Published: 'bg-green-100 text-green-700',
  Rejected: 'bg-gray-100 text-gray-500',
};

export const HISTORY_FIELD_LABELS: Record<string, string> = {
  status: 'ステータス',
  priority: '優先度',
  assignee: '担当者',
  escalation: 'エスカレーション',
};

export const NOTIFICATION_TYPE_LABELS: Record<string, string> = {
  assigned: '担当割当',
  escalated: 'エスカレーション',
  commented: 'コメント',
  statusChanged: 'ステータス変更',
};
