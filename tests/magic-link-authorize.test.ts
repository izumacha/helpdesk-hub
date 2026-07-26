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

  // 消費失敗 (消費済み / 失効 / 不在) は null を返し、監査行は書かないこと
  it('returns null and records nothing when the token cannot be consumed', async () => {
    consumeValidToken.mockResolvedValue(null);
    expect(await magicLinkAuthorize({ token: 'raw-token' })).toBeNull();
    expect(recordAuthAudit).not.toHaveBeenCalled();
  });

  // ユーザーが消えていれば null (孤児トークン)。監査行も書かない
  it('returns null for an orphaned token whose user no longer exists', async () => {
    consumeValidToken.mockResolvedValue(consumedToken('login'));
    findByEmail.mockResolvedValue(null);
    expect(await magicLinkAuthorize({ token: 'raw-token' })).toBeNull();
    expect(recordAuthAudit).not.toHaveBeenCalled();
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
