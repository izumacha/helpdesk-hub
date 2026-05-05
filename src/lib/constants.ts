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

// 状態ごとのバッジ配色 (Tailwind CSS クラス) ─ 健診/医療系の柔らかな soft chip
export const STATUS_COLORS: Record<string, string> = {
  New: 'bg-slate-100 text-slate-700 ring-1 ring-slate-200', // 新規: ニュートラルグレー
  Open: 'bg-teal-50 text-teal-800 ring-1 ring-teal-200', // オープン: ブランドティール
  WaitingForUser: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200', // ユーザー待ち: アンバー
  InProgress: 'bg-sky-50 text-sky-800 ring-1 ring-sky-200', // 対応中: スカイブルー
  Escalated: 'bg-rose-50 text-rose-800 ring-1 ring-rose-200', // エスカレーション: ロゼ
  Resolved: 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200', // 解決済み: ミントグリーン
  Closed: 'bg-slate-50 text-slate-500 ring-1 ring-slate-200', // クローズ: 薄いグレー
};

// 優先度ごとの文字色クラス (Tailwind CSS) ─ 視認性を保ちつつ過剰な強さを抑える
export const PRIORITY_COLORS: Record<string, string> = {
  Low: 'text-slate-500', // 低: グレー
  Medium: 'text-amber-700', // 中: 落ち着いたアンバー
  High: 'text-rose-700 font-semibold', // 高: ロゼ + 太字
};

// FAQ 状態キーに対応する日本語表示ラベル
export const FAQ_STATUS_LABELS: Record<string, string> = {
  Candidate: '候補',
  Published: '公開済み',
  Rejected: '却下',
};

// FAQ 状態ごとのバッジ配色 (Tailwind CSS クラス) ─ ステータスバッジと同方針
export const FAQ_STATUS_COLORS: Record<string, string> = {
  Candidate: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200', // 候補: アンバー
  Published: 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200', // 公開済み: ミントグリーン
  Rejected: 'bg-slate-50 text-slate-500 ring-1 ring-slate-200', // 却下: 薄いグレー
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
