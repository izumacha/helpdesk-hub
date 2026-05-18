// Vitest のテスト DSL + 環境変数スタブ
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// テスト対象 (ファクトリ本体とキャッシュ破棄)
import { getEmailSender, resetEmailSenderCache } from '@/lib/email';

describe('getEmailSender', () => {
  // 各テスト前後でキャッシュと env スタブを初期化する
  beforeEach(() => {
    resetEmailSenderCache();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEmailSenderCache();
  });

  // 本番で EMAIL_DRIVER 未設定なら起動時エラー (silently console に落ちない)
  it('production で EMAIL_DRIVER 未設定はエラーを投げる', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('EMAIL_DRIVER', '');
    expect(() => getEmailSender()).toThrow(/production では EMAIL_DRIVER=smtp/);
  });

  // 本番で EMAIL_DRIVER=console (誤設定) もエラー
  it('production で EMAIL_DRIVER=console はエラーを投げる', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('EMAIL_DRIVER', 'console');
    expect(() => getEmailSender()).toThrow(/production では EMAIL_DRIVER=smtp/);
  });

  // CI / E2E 用の escape hatch: EMAIL_ALLOW_CONSOLE_IN_PROD=true なら通す
  it('production でも EMAIL_ALLOW_CONSOLE_IN_PROD=true なら console を許容', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('EMAIL_DRIVER', 'console');
    vi.stubEnv('EMAIL_ALLOW_CONSOLE_IN_PROD', 'true');
    const sender = getEmailSender();
    // インスタンスが返ること (例外を投げない)
    expect(typeof sender.send).toBe('function');
  });

  // escape hatch の値が 'true' でないと許容しない (誤値での silent 通過を防ぐ)
  it('production で EMAIL_ALLOW_CONSOLE_IN_PROD=1 (truthy だが文字列違い) はエラー', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('EMAIL_DRIVER', 'console');
    vi.stubEnv('EMAIL_ALLOW_CONSOLE_IN_PROD', '1');
    expect(() => getEmailSender()).toThrow(/production では EMAIL_DRIVER=smtp/);
  });

  // dev/test では EMAIL_DRIVER 未設定でも Console にフォールバック
  it('非 production では EMAIL_DRIVER 未設定で Console にフォールバック', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('EMAIL_DRIVER', '');
    const sender = getEmailSender();
    // 例外を投げずインスタンスが返ること (実装の中身までは検証しない)
    expect(typeof sender.send).toBe('function');
  });

  // 未対応の EMAIL_DRIVER 値はエラー (タイポを silent に通さない)
  it('未対応の EMAIL_DRIVER 値はエラーを投げる', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('EMAIL_DRIVER', 'sendgrid');
    expect(() => getEmailSender()).toThrow(/未対応の EMAIL_DRIVER/);
  });

  // SMTP で必須環境変数が欠けている場合のエラー
  it('EMAIL_DRIVER=smtp で SMTP_HOST 未設定はエラー', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('EMAIL_DRIVER', 'smtp');
    vi.stubEnv('SMTP_HOST', '');
    vi.stubEnv('EMAIL_FROM', 'noreply@example.com');
    expect(() => getEmailSender()).toThrow(/SMTP_HOST が設定されていません/);
  });

  it('EMAIL_DRIVER=smtp で EMAIL_FROM 未設定はエラー', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('EMAIL_DRIVER', 'smtp');
    vi.stubEnv('SMTP_HOST', 'smtp.example.com');
    vi.stubEnv('EMAIL_FROM', '');
    expect(() => getEmailSender()).toThrow(/EMAIL_FROM が設定されていません/);
  });

  // SMTP_PORT が NaN / 0 / 範囲外などの無効値ならエラー (early validation)
  it.each(['abc', '0', '-1', '70000', '3.14'])(
    'EMAIL_DRIVER=smtp で SMTP_PORT=%s はエラー',
    (badPort) => {
      vi.stubEnv('NODE_ENV', 'test');
      vi.stubEnv('EMAIL_DRIVER', 'smtp');
      vi.stubEnv('SMTP_HOST', 'smtp.example.com');
      vi.stubEnv('SMTP_PORT', badPort);
      vi.stubEnv('EMAIL_FROM', 'noreply@example.com');
      expect(() => getEmailSender()).toThrow(/SMTP_PORT/);
    },
  );

  // SMTP_PORT 既定値 (未指定→587) でインスタンス生成できること
  it('EMAIL_DRIVER=smtp で SMTP_PORT 未指定でも 587 で生成される', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('EMAIL_DRIVER', 'smtp');
    vi.stubEnv('SMTP_HOST', 'smtp.example.com');
    vi.stubEnv('SMTP_PORT', '');
    vi.stubEnv('EMAIL_FROM', 'noreply@example.com');
    const sender = getEmailSender();
    expect(typeof sender.send).toBe('function');
  });
});
