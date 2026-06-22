// Vitest のテスト DSL
import { describe, expect, it } from 'vitest';

// 課金プランの上限・機能フラグ判定ヘルパー (テスト対象)
import {
  USER_LIMIT,
  MONTHLY_TICKET_LIMIT,
  isEmailInboundAllowed,
  isAuditLogAllowed,
  isLineIntegrationAllowed,
  isProModeAllowed,
  isSsoAllowed,
  isUserLimitReached,
  isMonthlyTicketLimitReached,
  getUserLimit,
  getMonthlyTicketLimit,
} from '../src/lib/plan-guard';
// プラン型 (網羅性の担保に使う)
import type { SubscriptionPlan } from '../src/domain/types';

// テスト対象の全プラン (新プラン追加時にここを更新し忘れないよう一覧化)
const ALL_PLANS: SubscriptionPlan[] = ['free', 'standard', 'pro', 'enterprise'];

// プランごとの上限・機能フラグが仕様 (smb-dx-pivot-plan.md §6.1) どおりかを検証する
describe('plan-guard: プランごとの上限と機能フラグ', () => {
  // 全プランが上限テーブルに登録されていること (網羅漏れ検知)
  it('全プランが USER_LIMIT / MONTHLY_TICKET_LIMIT に存在する', () => {
    // すべてのプランについてキーが定義されているか確認する
    for (const plan of ALL_PLANS) {
      // ユーザー上限が定義されている
      expect(USER_LIMIT[plan]).toBeDefined();
      // 月間チケット上限が定義されている
      expect(MONTHLY_TICKET_LIMIT[plan]).toBeDefined();
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

  // 月間チケット上限: Free のみ到達し得る、無制限プランは常に false
  it('isMonthlyTicketLimitReached は無制限プランで常に false', () => {
    expect(isMonthlyTicketLimitReached('free', 50)).toBe(true); // 50 >= 50 到達
    expect(isMonthlyTicketLimitReached('free', 49)).toBe(false); // 49 < 50 未到達
    expect(isMonthlyTicketLimitReached('pro', 999999)).toBe(false); // 無制限
    expect(isMonthlyTicketLimitReached('enterprise', 999999)).toBe(false); // 無制限
  });

  // 表示用ヘルパーは無制限を -1 で返す (UI は -1 を「無制限」と解釈する規約)
  it('getUserLimit / getMonthlyTicketLimit は無制限を -1 で返す', () => {
    expect(getUserLimit('pro')).toBe(30); // 有限はそのまま
    expect(getUserLimit('enterprise')).toBe(-1); // 無制限は -1
    expect(getMonthlyTicketLimit('free')).toBe(50); // 有限はそのまま
    expect(getMonthlyTicketLimit('enterprise')).toBe(-1); // 無制限は -1
  });
});
