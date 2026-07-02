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

// スタッフシート上限 (プランごと)。agent + admin のみカウントし requester はシートを消費しない
export const USER_LIMIT: Record<SubscriptionPlan, number> = {
  free: 3, // Free: スタッフ 3 名まで
  standard: 10, // Standard: スタッフ 10 名まで
  pro: 30, // Pro: スタッフ 30 名まで
  enterprise: Infinity, // Enterprise: 無制限 (個別見積)
};

// 月間チケット起票数の上限 (プランごと)。Free のみ制限あり
export const MONTHLY_TICKET_LIMIT: Record<SubscriptionPlan, number> = {
  free: 50, // Free: 月 50 件まで
  standard: Infinity, // Standard: 無制限
  pro: Infinity, // Pro: 無制限
  enterprise: Infinity, // Enterprise: 無制限
};

// ─────────────────────────────────────────────────────────────────────────────
// プラン機能可用性フラグ
// ─────────────────────────────────────────────────────────────────────────────

// メール取り込み機能の利用可否 (Standard 以上で有効)
export function isEmailInboundAllowed(plan: SubscriptionPlan): boolean {
  // Free プランはメール取り込み不可 (Standard 以上の差別化要素)
  return plan !== 'free';
}

// 監査ログ機能の利用可否 (Pro 以上)。Enterprise は「監査強化」として当然含む
export function isAuditLogAllowed(plan: SubscriptionPlan): boolean {
  // Pro / Enterprise プランのみ監査ログにアクセスできる (smb-dx-pivot-plan.md §6.1)
  return plan === 'pro' || plan === 'enterprise';
}

// LINE 連携機能の利用可否 (Pro 以上)
export function isLineIntegrationAllowed(plan: SubscriptionPlan): boolean {
  // Pro / Enterprise プランで LINE 連携が有効
  return plan === 'pro' || plan === 'enterprise';
}

// Pro モード (7 ステータス・SLA・エスカレーション等) の利用可否
// Standard と Pro の両方で Pro モードを許可する判断については、
// 画面の mode フラグ (lite/pro) を管理者が個別に切り替える設計のため、
// プラン上は Pro / Enterprise プランが既定で pro mode になる
export function isProModeAllowed(plan: SubscriptionPlan): boolean {
  // Pro / Enterprise プランで Pro モードのフル機能を有効化できる
  return plan === 'pro' || plan === 'enterprise';
}

// SSO (SAML) シングルサインオンの利用可否 (Enterprise のみ)。
// docs/smb-dx-pivot-plan.md §6.1 で Enterprise 専用機能として位置づけられている。
// SSO 設定・ログインの各エンドポイントはこのゲートでサーバー側強制する (UI 非表示に頼らない)。
export function isSsoAllowed(plan: SubscriptionPlan): boolean {
  // Enterprise プランのみ SSO を構成・利用できる
  return plan === 'enterprise';
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

// プランのユーザー上限値を返す (UI 表示用)。無制限 (Infinity) の場合は -1 を返す
// (getMonthlyTicketLimit と同じ規約。呼び出し側は -1 を「無制限」として扱う)
export function getUserLimit(plan: SubscriptionPlan): number {
  const limit = USER_LIMIT[plan];
  return Number.isFinite(limit) ? limit : -1;
}

// プランの月間チケット上限値を返す (UI 表示用)。Infinity の場合は -1 を返す
export function getMonthlyTicketLimit(plan: SubscriptionPlan): number {
  const limit = MONTHLY_TICKET_LIMIT[plan];
  return Number.isFinite(limit) ? limit : -1;
}
