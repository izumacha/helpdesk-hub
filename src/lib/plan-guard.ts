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

// 添付ファイルの累計サイズ上限 (バイト、プランごと)。docs/smb-dx-pivot-plan.md §6.1 で明記されて
// いるのは Standard の「添付1GB」のみで、他プランに数値の定めは無い。MONTHLY_TICKET_LIMIT と同じ
// 規約 (明記されたプランだけ有限値、それ以外は無制限) に揃える
export const ATTACHMENT_TOTAL_SIZE_LIMIT_BYTES: Record<SubscriptionPlan, number> = {
  free: Infinity, // Free: 計画書に上限の定めなし (無制限)
  standard: 1024 * 1024 * 1024, // Standard: 1GB (§6.1 に明記)
  pro: Infinity, // Pro: 計画書に上限の定めなし (無制限)
  enterprise: Infinity, // Enterprise: 無制限
};

// ─────────────────────────────────────────────────────────────────────────────
// トライアル (§7.2「30日間の Free trial (Standard 相当)」)
// ─────────────────────────────────────────────────────────────────────────────

// トライアル中に昇格させる先のプラン (Standard 相当)
const TRIAL_EFFECTIVE_PLAN: SubscriptionPlan = 'standard';

// トライアル期間 (30 日、ミリ秒)。テナント作成時に trialEndsAt = 作成時刻 + この値で設定する
export const FREE_TRIAL_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

// テナントの実際の課金プラン (subscriptionPlan) とトライアル終了日時から、
// 各種プランゲート判定に使う「実効プラン」を解決する純粋関数。
// Free プランでトライアル期間中 (trialEndsAt が未来) なら Standard 相当として扱い、
// それ以外 (トライアル対象外・終了済み・Standard 以上に課金済み) はそのまま返す。
// Stripe で正式に課金プランへ上がった場合は subscriptionPlan 自体が更新されるため、
// この関数の判定を経由しても実際のプランがそのまま尊重される (トライアルで上書きされない)。
// SSO (Enterprise 限定) や LINE 連携 (Pro 以上限定) など Standard より上位のゲートは、
// トライアルでは昇格しない (「Standard 相当」の範囲を超えるプラン限定機能は対象外)。
export function resolveEffectivePlan(
  subscriptionPlan: SubscriptionPlan,
  trialEndsAt: Date | null,
  now: Date = new Date(),
): SubscriptionPlan {
  // Free 以外は課金済み (またはそれ以上) なのでトライアル判定は不要
  if (subscriptionPlan !== 'free') return subscriptionPlan;
  // トライアル未設定、または既に終了していれば無印の Free のまま
  if (trialEndsAt === null || trialEndsAt.getTime() <= now.getTime()) return subscriptionPlan;
  // トライアル期間中: Standard 相当に昇格させる
  return TRIAL_EFFECTIVE_PLAN;
}

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

// Pro モードへの切替を許可するプランの一覧 (単一の源)。isProModeAllowed だけでなく、
// TenantRepository.updateMode の原子的な CAS (compare-and-swap) 更新の where 条件にも
// そのまま渡す (監査で発見したギャップ対応: 管理者操作と Stripe Webhook 由来の自動
// ダウングレードが競合する TOCTOU を防ぐため、プラン判定と書き込みを同じ配列で揃える)
export const PRO_MODE_ALLOWED_PLANS: readonly SubscriptionPlan[] = ['pro', 'enterprise'];

// Pro モード (7 ステータス・SLA・エスカレーション等) の利用可否
// Standard と Pro の両方で Pro モードを許可する判断については、
// 画面の mode フラグ (lite/pro) を管理者が個別に切り替える設計のため、
// プラン上は Pro / Enterprise プランが既定で pro mode になる
export function isProModeAllowed(plan: SubscriptionPlan): boolean {
  // Pro / Enterprise プランで Pro モードのフル機能を有効化できる
  return PRO_MODE_ALLOWED_PLANS.includes(plan);
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

// プランの添付累計サイズ上限 (バイト) を返す (UI 表示用)。Infinity の場合は -1 を返す
// (getUserLimit / getMonthlyTicketLimit と同じ規約)
export function getAttachmentSizeLimit(plan: SubscriptionPlan): number {
  const limit = ATTACHMENT_TOTAL_SIZE_LIMIT_BYTES[plan];
  return Number.isFinite(limit) ? limit : -1;
}
