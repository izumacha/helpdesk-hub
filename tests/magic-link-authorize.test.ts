// マジックリンク認証ロジック (src/lib/magic-link-authorize.ts) の単体テスト。
// auth.ts から分離したことで、トークン消費・ユーザー解決・認証イベント監査 (purpose 別の
// イベント選択) を NextAuth 初期化なしに検証できる (password-authorize.test.ts と同じ流儀)。

import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock のファクトリはファイル先頭へ巻き上げられるため、参照する mock 関数は
// vi.hoisted で同様に巻き上げて「初期化前参照」エラーを避ける
const { consumeValidToken, findByEmail, recordAuthAudit } = vi.hoisted(() => ({
  consumeValidToken: vi.fn(),
  findByEmail: vi.fn(),
  recordAuthAudit: vi.fn(),
}));

// データ層をモック: magicLinkAuthorize が使うのは magicLinks.consumeValidToken /
// users.findByEmail / authAudit.record (auth-audit.ts ヘルパー経由) のみ
vi.mock('@/data', () => ({
  repos: {
    magicLinks: { consumeValidToken },
    users: { findByEmail },
    authAudit: { record: recordAuthAudit },
  },
}));

// テスト対象 (モック設定後に import する)
import { magicLinkAuthorize } from '@/lib/magic-link-authorize';
// 生トークン→DB 検索キーのハッシュ計算 (モックした consumeValidToken の引数検証に使う)
import { hashMagicLinkToken } from '@/lib/magic-link';
// 本人を特定できない失敗経路で記録される代替メール (期待値の直書きを避ける)
import { AUTH_AUDIT_UNKNOWN_EMAIL } from '@/lib/auth-audit';

// テストで使う既存ユーザー
const USER = {
  id: 'u1',
  email: 'agent@example.com',
  name: 'エージェント太郎',
  role: 'agent' as const,
  tenantId: 't1',
  passwordHash: 'x',
  createdAt: new Date(),
  updatedAt: new Date(),
};

// 消費済みトークン行のひな型を作る (purpose だけ差し替えて使う)
function consumedToken(purpose: 'login' | 'ssoHandoff') {
  return {
    id: 'ml1',
    email: USER.email,
    tokenHash: 'hash',
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: new Date(),
    requestedIp: null,
    createdAt: new Date(),
    purpose,
  };
}

describe('magicLinkAuthorize', () => {
  beforeEach(() => {
    // モックの実装と履歴をテストごとにリセットする
    consumeValidToken.mockReset();
    findByEmail.mockReset();
    recordAuthAudit.mockReset();
  });

  // トークンが無ければ即 null (DB も触らない)
  it('returns null when no token is provided', async () => {
    expect(await magicLinkAuthorize(undefined)).toBeNull();
    expect(await magicLinkAuthorize({})).toBeNull();
    expect(consumeValidToken).not.toHaveBeenCalled();
  });

  // トークンはハッシュ化してから消費に渡すこと (生トークンを DB 検索キーにしない)
  it('hashes the raw token before consuming it', async () => {
    consumeValidToken.mockResolvedValue(null);
    await magicLinkAuthorize({ token: 'raw-token' });
    // 生トークンの SHA-256 ハッシュが検索キーとして渡っている
    const expectedHash = await hashMagicLinkToken('raw-token');
    expect(consumeValidToken).toHaveBeenCalledWith(
      expect.objectContaining({ tokenHash: expectedHash }),
    );
  });

  // 消費失敗 (消費済み / 失効 / 不在) は null を返し、失敗イベントを監査に残すこと。
  // この時点では DB に該当行が無く対象メールを特定できないため email は代替値になる
  it('returns null and records a failure with an unknown email when the token cannot be consumed', async () => {
    consumeValidToken.mockResolvedValue(null);
    expect(await magicLinkAuthorize({ token: 'raw-token' })).toBeNull();
    // 失敗イベントが「特定不能な試行」として記録されている
    expect(recordAuthAudit).toHaveBeenCalledWith({
      event: 'magic_link_login_failure',
      email: AUTH_AUDIT_UNKNOWN_EMAIL,
      userId: null,
      tenantId: null,
    });
  });

  // ユーザーが消えていれば null (孤児トークン)。トークン行から分かる実メールで失敗を記録する
  it('returns null and records a failure for an orphaned token whose user no longer exists', async () => {
    consumeValidToken.mockResolvedValue(consumedToken('login'));
    findByEmail.mockResolvedValue(null);
    expect(await magicLinkAuthorize({ token: 'raw-token' })).toBeNull();
    // 対象メールはトークン行から判明しているのでそのまま記録される (userId/tenantId は不明)
    expect(recordAuthAudit).toHaveBeenCalledWith({
      event: 'magic_link_login_failure',
      email: USER.email,
      userId: null,
      tenantId: null,
    });
  });

  // SSO 引き渡しトークンの孤児ケースも同じ失敗イベントで記録すること
  // (失敗の原因はユーザー消失で経路によらず同一のため、種別を分けても調査情報が増えない)
  it('records the same failure event for an orphaned ssoHandoff token', async () => {
    consumeValidToken.mockResolvedValue(consumedToken('ssoHandoff'));
    findByEmail.mockResolvedValue(null);
    expect(await magicLinkAuthorize({ token: 'raw-token' })).toBeNull();
    expect(recordAuthAudit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'magic_link_login_failure', email: USER.email }),
    );
  });

  // 通常のマジックリンク (purpose='login') の成功は magic_link_login_success として記録される
  it('records magic_link_login_success for a login-purpose token', async () => {
    consumeValidToken.mockResolvedValue(consumedToken('login'));
    findByEmail.mockResolvedValue(USER);
    // 認証は成功し、セッション用のユーザー情報が返る
    const res = await magicLinkAuthorize({ token: 'raw-token' });
    expect(res).toMatchObject({ id: 'u1', role: 'agent', tenantId: 't1' });
    // 監査イベントはマジックリンク成功として記録されている
    expect(recordAuthAudit).toHaveBeenCalledWith({
      event: 'magic_link_login_success',
      email: USER.email,
      userId: 'u1',
      tenantId: 't1',
    });
  });

  // SSO ハンドオフ (purpose='ssoHandoff') の成功は sso_login_success として記録される
  it('records sso_login_success for an ssoHandoff-purpose token', async () => {
    consumeValidToken.mockResolvedValue(consumedToken('ssoHandoff'));
    findByEmail.mockResolvedValue(USER);
    const res = await magicLinkAuthorize({ token: 'raw-token' });
    expect(res).toMatchObject({ id: 'u1' });
    // 監査イベントは SSO ログイン成功として記録されている (purpose で経路を区別する)
    expect(recordAuthAudit).toHaveBeenCalledWith({
      event: 'sso_login_success',
      email: USER.email,
      userId: 'u1',
      tenantId: 't1',
    });
  });
});
