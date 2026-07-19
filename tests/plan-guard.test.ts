// Vitest のテスト DSL
import { describe, expect, it } from 'vitest';

// 課金プランの上限・機能フラグ判定ヘルパー (テスト対象)
import {
  USER_LIMIT,
  MONTHLY_TICKET_LIMIT,
  ATTACHMENT_TOTAL_SIZE_LIMIT_BYTES,
  FREE_TRIAL_DURATION_MS,
  isAdditionalTenantCreationAllowed,
  isEmailInboundAllowed,
  isAuditLogAllowed,
  isLineIntegrationAllowed,
  isProModeAllowed,
  isSsoAllowed,
  isUserLimitReached,
  getUserLimit,
  getMonthlyTicketLimit,
  getAttachmentSizeLimit,
  resolveEffectivePlan,
} from '../src/lib/plan-guard';
// プラン型 (網羅性の担保に使う)
import type { SubscriptionPlan } from '../src/domain/types';

// テスト対象の全プラン (新プラン追加時にここを更新し忘れないよう一覧化)
const ALL_PLANS: SubscriptionPlan[] = ['free', 'standard', 'pro', 'enterprise'];

// プランごとの上限・機能フラグが仕様 (smb-dx-pivot-plan.md §6.1) どおりかを検証する
describe('plan-guard: プランごとの上限と機能フラグ', () => {
  // 全プランが上限テーブルに登録されていること (網羅漏れ検知)
  it('全プランが USER_LIMIT / MONTHLY_TICKET_LIMIT / ATTACHMENT_TOTAL_SIZE_LIMIT_BYTES に存在する', () => {
    // すべてのプランについてキーが定義されているか確認する
    for (const plan of ALL_PLANS) {
      // ユーザー上限が定義されている
      expect(USER_LIMIT[plan]).toBeDefined();
      // 月間チケット上限が定義されている
      expect(MONTHLY_TICKET_LIMIT[plan]).toBeDefined();
      // 添付累計サイズ上限が定義されている
      expect(ATTACHMENT_TOTAL_SIZE_LIMIT_BYTES[plan]).toBeDefined();
    }
  });

  // ユーザー上限の具体値 (Free=3, Standard=10, Pro=30, Enterprise=無制限)
  it('ユーザー上限がプランごとに正しい', () => {
    expect(USER_LIMIT.free).toBe(3); // Free は 3 名
    expect(USER_LIMIT.standard).toBe(10); // Standard は 10 名
    expect(USER_LIMIT.pro).toBe(30); // Pro は 30 名
    expect(USER_LIMIT.enterprise).toBe(Infinity); // Enterprise は無制限
  });

  // 月間チケット上限は Free のみ有限、それ以外は無制限
  it('月間チケット上限は Free のみ 50 件、他は無制限', () => {
    expect(MONTHLY_TICKET_LIMIT.free).toBe(50); // Free は月 50 件
    expect(MONTHLY_TICKET_LIMIT.standard).toBe(Infinity); // Standard 無制限
    expect(MONTHLY_TICKET_LIMIT.pro).toBe(Infinity); // Pro 無制限
    expect(MONTHLY_TICKET_LIMIT.enterprise).toBe(Infinity); // Enterprise 無制限
  });

  // 添付累計サイズ上限は Standard のみ有限 (1GB)、他は無制限 (§6.1 に明記されているのが
  // Standard のみのため。MONTHLY_TICKET_LIMIT と同じ「明記プランだけ有限」規約)
  it('添付累計サイズ上限は Standard のみ 1GB、他は無制限', () => {
    expect(ATTACHMENT_TOTAL_SIZE_LIMIT_BYTES.free).toBe(Infinity); // Free 無制限
    expect(ATTACHMENT_TOTAL_SIZE_LIMIT_BYTES.standard).toBe(1024 * 1024 * 1024); // Standard 1GB
    expect(ATTACHMENT_TOTAL_SIZE_LIMIT_BYTES.pro).toBe(Infinity); // Pro 無制限
    expect(ATTACHMENT_TOTAL_SIZE_LIMIT_BYTES.enterprise).toBe(Infinity); // Enterprise 無制限
  });

  // メール取り込みは Free 以外で有効
  it('メール取り込みは Free 以外で有効', () => {
    expect(isEmailInboundAllowed('free')).toBe(false); // Free は不可
    expect(isEmailInboundAllowed('standard')).toBe(true); // Standard 可
    expect(isEmailInboundAllowed('pro')).toBe(true); // Pro 可
    expect(isEmailInboundAllowed('enterprise')).toBe(true); // Enterprise 可
  });

  // 監査ログは Pro / Enterprise のみ
  it('監査ログは Pro / Enterprise のみ', () => {
    expect(isAuditLogAllowed('free')).toBe(false); // Free 不可
    expect(isAuditLogAllowed('standard')).toBe(false); // Standard 不可
    expect(isAuditLogAllowed('pro')).toBe(true); // Pro 可
    expect(isAuditLogAllowed('enterprise')).toBe(true); // Enterprise 可
  });

  // LINE 連携は Pro / Enterprise のみ
  it('LINE 連携は Pro / Enterprise のみ', () => {
    expect(isLineIntegrationAllowed('free')).toBe(false); // Free 不可
    expect(isLineIntegrationAllowed('standard')).toBe(false); // Standard 不可
    expect(isLineIntegrationAllowed('pro')).toBe(true); // Pro 可
    expect(isLineIntegrationAllowed('enterprise')).toBe(true); // Enterprise 可
  });

  // Pro モードは Pro / Enterprise のみ
  it('Pro モードは Pro / Enterprise のみ', () => {
    expect(isProModeAllowed('free')).toBe(false); // Free 不可
    expect(isProModeAllowed('standard')).toBe(false); // Standard 不可
    expect(isProModeAllowed('pro')).toBe(true); // Pro 可
    expect(isProModeAllowed('enterprise')).toBe(true); // Enterprise 可
  });

  // SSO (SAML) は Enterprise のみ
  it('SSO は Enterprise のみ許可', () => {
    expect(isSsoAllowed('free')).toBe(false); // Free 不可
    expect(isSsoAllowed('standard')).toBe(false); // Standard 不可
    expect(isSsoAllowed('pro')).toBe(false); // Pro 不可
    expect(isSsoAllowed('enterprise')).toBe(true); // Enterprise のみ可
  });

  // フォローアップ (監査で発見したギャップ): 新規組織作成は Free 以外の全プランで許可する
  // (トライアル連鎖の悪用防止のため、この関数には raw plan を渡す契約であることが前提)
  it('新規組織作成はFree以外の全プランで許可される', () => {
    expect(isAdditionalTenantCreationAllowed('free')).toBe(false); // Free (トライアル中含む) は不可
    expect(isAdditionalTenantCreationAllowed('standard')).toBe(true); // Standard 可
    expect(isAdditionalTenantCreationAllowed('pro')).toBe(true); // Pro 可
    expect(isAdditionalTenantCreationAllowed('enterprise')).toBe(true); // Enterprise 可
  });
});

// 上限到達判定と UI 表示用ヘルパーの境界値を検証する
describe('plan-guard: 上限到達判定と表示ヘルパー', () => {
  // ユーザー数が上限と同数なら到達 (>= 判定の境界)
  it('isUserLimitReached は上限と同数で true', () => {
    expect(isUserLimitReached('free', 2)).toBe(false); // 2 < 3 は未到達
    expect(isUserLimitReached('free', 3)).toBe(true); // 3 >= 3 は到達
  });

  // Enterprise は無制限なのでどれだけ増えても到達しない
  it('Enterprise はユーザー上限に到達しない', () => {
    expect(isUserLimitReached('enterprise', 100000)).toBe(false); // 無制限
  });

  // 表示用ヘルパーは無制限を -1 で返す (UI は -1 を「無制限」と解釈する規約)
  it('getUserLimit / getMonthlyTicketLimit / getAttachmentSizeLimit は無制限を -1 で返す', () => {
    expect(getUserLimit('pro')).toBe(30); // 有限はそのまま
    expect(getUserLimit('enterprise')).toBe(-1); // 無制限は -1
    expect(getMonthlyTicketLimit('free')).toBe(50); // 有限はそのまま
    expect(getMonthlyTicketLimit('enterprise')).toBe(-1); // 無制限は -1
    expect(getAttachmentSizeLimit('standard')).toBe(1024 * 1024 * 1024); // 有限はそのまま
    expect(getAttachmentSizeLimit('free')).toBe(-1); // 無制限は -1
  });
});

// §7.2「30日間の Free trial (Standard 相当)」の実効プラン解決ロジック
describe('plan-guard: resolveEffectivePlan (Free trial)', () => {
  // 基準時刻を固定する (時差ぶれを避ける)
  const now = new Date('2026-04-17T00:00:00Z');
  const future = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000); // 10 日後 (トライアル中)
  const past = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000); // 1 日前 (トライアル終了済み)

  // 30 日 = FREE_TRIAL_DURATION_MS であることを固定する (create-tenant.ts が使う定数)
  it('FREE_TRIAL_DURATION_MS は 30 日 (ミリ秒)', () => {
    expect(FREE_TRIAL_DURATION_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  // Free プランでトライアル期間中なら Standard に昇格する
  it('Free プランでトライアル期間中は Standard に昇格する', () => {
    expect(resolveEffectivePlan('free', future, now)).toBe('standard');
  });

  // トライアル終了済みなら free のまま
  it('トライアルが終了済みなら free のまま', () => {
    expect(resolveEffectivePlan('free', past, now)).toBe('free');
  });

  // trialEndsAt が未設定 (null) なら free のまま
  it('trialEndsAt が null なら free のまま', () => {
    expect(resolveEffectivePlan('free', null, now)).toBe('free');
  });

  // Free 以外のプランはトライアル判定の対象外 (課金済みプランをそのまま返す)。
  // trialEndsAt が (Stripe 解約後の名残り等で) 未来の値のまま残っていても昇格しない
  it('Free 以外のプランはそのまま返す (トライアル判定の対象外)', () => {
    expect(resolveEffectivePlan('standard', future, now)).toBe('standard');
    expect(resolveEffectivePlan('pro', future, now)).toBe('pro');
    expect(resolveEffectivePlan('enterprise', future, now)).toBe('enterprise');
  });

  // 境界値: trialEndsAt がちょうど now と同時刻なら「終了済み」扱い (未来でなければ昇格しない)
  it('trialEndsAt が now と同時刻なら終了済み扱い', () => {
    expect(resolveEffectivePlan('free', now, now)).toBe('free');
  });
});
