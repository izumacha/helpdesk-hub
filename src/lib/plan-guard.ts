// Phase 4 課金: サブスクリプションプランごとの利用制限を判定するヘルパー群。
// docs/smb-dx-pivot-plan.md §6.1「料金プラン」の制限値を単一箇所に集約し、
// Server Action や API Route から参照する (SSOT = Single Source of Truth 原則)。
//
// 制限はテナントごとの plan フィールドを元に判定し、UI 非表示だけに頼らず
// サーバー側でも必ず確認する (§9 セキュリティ: 認可はサーバー側で強制)。

// 課金プランの型
import type { SubscriptionPlan } from '@/domain/types';

// ─────────────────────────────────────────────────────────────────────────────
// プランごとの上限値定数
// ─────────────────────────────────────────────────────────────────────────────

// ユーザー数上限 (プランごと)。超えた場合は新規招待・アカウント登録を拒否する
export const USER_LIMIT: Record<SubscriptionPlan, number> = {
  free: 3, // Free: 3 名まで
  standard: 10, // Standard: 10 名まで
  pro: 30, // Pro: 30 名まで
};

// 月間チケット起票数の上限 (プランごと)。Free のみ制限あり
export const MONTHLY_TICKET_LIMIT: Record<SubscriptionPlan, number> = {
  free: 50, // Free: 月 50 件まで
  standard: Infinity, // Standard: 無制限
  pro: Infinity, // Pro: 無制限
};

// ─────────────────────────────────────────────────────────────────────────────
// プラン機能可用性フラグ
// ─────────────────────────────────────────────────────────────────────────────

// メール取り込み機能の利用可否 (Standard 以上で有効)
export function isEmailInboundAllowed(plan: SubscriptionPlan): boolean {
  // Free プランはメール取り込み不可 (Standard 以上の差別化要素)
  return plan !== 'free';
}

// 監査ログ機能の利用可否 (Pro のみ)
export function isAuditLogAllowed(plan: SubscriptionPlan): boolean {
  // Pro プランのみ監査ログにアクセスできる (smb-dx-pivot-plan.md §6.1)
  return plan === 'pro';
}

// LINE 連携機能の利用可否 (Pro のみ)
export function isLineIntegrationAllowed(plan: SubscriptionPlan): boolean {
  // Pro プランのみ LINE 連携が有効
  return plan === 'pro';
}

// Pro モード (7 ステータス・SLA・エスカレーション等) の利用可否
// Standard と Pro の両方で Pro モードを許可する判断については、
// 画面の mode フラグ (lite/pro) を管理者が個別に切り替える設計のため、
// プラン上は Pro プランのみが既定で pro mode になる
export function isProModeAllowed(plan: SubscriptionPlan): boolean {
  // Pro プランのみ Pro モードのフル機能を有効化できる
  return plan === 'pro';
}

// ─────────────────────────────────────────────────────────────────────────────
// 上限チェック関数
// ─────────────────────────────────────────────────────────────────────────────

// 現在のユーザー数が上限に達しているかを判定する
// plan: テナントの現在プラン / currentCount: 現在のユーザー数
export function isUserLimitReached(plan: SubscriptionPlan, currentCount: number): boolean {
  // 現在のユーザー数が上限以上なら true (新規追加不可)
  return currentCount >= USER_LIMIT[plan];
}

// 月間チケット起票数が上限に達しているかを判定する
// plan: テナントの現在プラン / currentMonthlyCount: 今月起票済み件数
export function isMonthlyTicketLimitReached(
  plan: SubscriptionPlan,
  currentMonthlyCount: number,
): boolean {
  const limit = MONTHLY_TICKET_LIMIT[plan];
  // Infinity の場合は常に false (制限なし)
  return Number.isFinite(limit) && currentMonthlyCount >= limit;
}

// プランのユーザー上限値を返す (UI 表示用)
export function getUserLimit(plan: SubscriptionPlan): number {
  return USER_LIMIT[plan];
}

// プランの月間チケット上限値を返す (UI 表示用)。Infinity の場合は -1 を返す
export function getMonthlyTicketLimit(plan: SubscriptionPlan): number {
  const limit = MONTHLY_TICKET_LIMIT[plan];
  return Number.isFinite(limit) ? limit : -1;
}
