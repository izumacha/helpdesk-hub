// Vitest のテスト DSL とモック機能
import { beforeEach, describe, expect, it, vi } from 'vitest';
// メモリ実装の context (store/repos/uow)
import { createMemoryContext, type Store } from '@/data/adapters/memory';
// リポジトリ束 / UnitOfWork の型
import type { Repos, UnitOfWork } from '@/data/ports/unit-of-work';
// 招待トークンのハッシュ化 (DB 保存値と同じ SHA-256 を作るために使う)
import { hashInviteToken } from '@/lib/invite';

// 各テスト前に書き換える依存。Action import 前に getter で参照させる
let store: Store;
let repos: Repos;
let uow: UnitOfWork;

// @/data を差し替え。getter で参照することで、テスト中の上書きが反映される
vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
  get uow() {
    return uow;
  },
}));

// 動的 import: 上のモック設定が反映された後で対象を読み込む
async function loadAction() {
  const mod = await import('@/features/auth/actions/accept-invitation');
  return mod.acceptInvitation;
}

// テナント A / B の ID。受諾は B 側の招待で行い、A に漏れないことを確認する
const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

// テストごとにクリーンな状態 + テナント 2 つを用意する
beforeEach(() => {
  const ctx = createMemoryContext();
  store = ctx.store;
  repos = ctx.repos;
  uow = ctx.uow;
  // 現在時刻 (テナント作成日時に使う)
  const now = new Date();
  // テナント A / B を投入する (User の FK 先として必要)
  for (const [id, name] of [
    [TENANT_A, 'A 組織'],
    [TENANT_B, 'B 組織'],
  ] as const) {
    store.tenants.set(id, { id, name, mode: 'lite', industry: null, inboundToken: null, createdAt: now });
  }
});

// 招待を 1 件作成して生トークンを返すヘルパー
async function seedInvitation(overrides: {
  tenantId: string;
  role: 'requester' | 'agent';
  email?: string | null;
  expiresAt?: Date;
}): Promise<string> {
  // 生トークン (テスト内では固定文字列で十分。ハッシュ化して保存する)
  const rawToken = `raw-${overrides.tenantId}-${overrides.role}-${Math.random()}`;
  // DB 保存値と同じ SHA-256 ハッシュへ変換する
  const tokenHash = await hashInviteToken(rawToken);
  // 招待行を作成する
  await repos.invitations.create({
    tokenHash,
    tenantId: overrides.tenantId,
    role: overrides.role,
    email: overrides.email ?? null,
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60_000),
  });
  // 受諾アクションに渡す生トークンを返す
  return rawToken;
}

// FormData を組み立てるヘルパー
function makeForm(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe('acceptInvitation', () => {
  // 招待行のテナント・権限でユーザーが作られること (tenantId は入力ではなく招待由来)
  it('招待が指すテナント・権限でユーザーを作成する (クロステナント注入なし)', async () => {
    // テナント B・担当者(agent)・メール付きの招待を用意する
    const rawToken = await seedInvitation({
      tenantId: TENANT_B,
      role: 'agent',
      email: 'invitee@example.com',
    });
    // 受諾アクションを実行 (氏名 + パスワードのみ。tenantId は一切渡さない)
    const acceptInvitation = await loadAction();
    const result = await acceptInvitation(rawToken, makeForm({ name: '招待 太郎', password: 'password123' }));

    // 戻り値のメールは招待行のメール
    expect(result.email).toBe('invitee@example.com');
    // 作成されたユーザーを store から探す
    const created = [...store.users.values()].find((u) => u.email === 'invitee@example.com');
    // テナントは招待行 (B) のもの。A には作られない
    expect(created?.tenantId).toBe(TENANT_B);
    // 権限は招待行の agent
    expect(created?.role).toBe('agent');
  });

  // 招待にメールが無い場合は、入力されたメールでユーザーを作ること
  it('メール無し招待では入力メールでユーザーを作る', async () => {
    // メール無しの招待を用意する
    const rawToken = await seedInvitation({ tenantId: TENANT_B, role: 'requester', email: null });
    // 受諾アクションを実行 (フォームでメールを入力)
    const acceptInvitation = await loadAction();
    const result = await acceptInvitation(
      rawToken,
      makeForm({ name: '自前 花子', password: 'password123', email: 'self@example.com' }),
    );
    // 入力メールでユーザーが作られる
    expect(result.email).toBe('self@example.com');
    expect([...store.users.values()].some((u) => u.email === 'self@example.com')).toBe(true);
  });

  // メール無し招待で不正な形式のメールを入力した場合は拒否されること (消費されない)
  it('メール無し招待で不正なメール形式は拒否される', async () => {
    // メール無しの招待を用意する
    const rawToken = await seedInvitation({ tenantId: TENANT_B, role: 'requester', email: null });
    const tokenHash = await hashInviteToken(rawToken);
    const acceptInvitation = await loadAction();
    // 不正な形式のメールを入力すると拒否される
    await expect(
      acceptInvitation(
        rawToken,
        makeForm({ name: '不正', password: 'password123', email: 'not-an-email' }),
      ),
    ).rejects.toThrow(/メールアドレス/);
    // 招待は未消費のまま (消費前に弾いている)
    const invitation = await repos.invitations.findByTokenHash(tokenHash);
    expect(invitation?.consumedAt).toBeNull();
  });

  // 同じ招待リンクは 2 回使えないこと (単回使用)
  it('同じ招待リンクは 2 回受諾できない', async () => {
    // 有効な招待を用意する
    const rawToken = await seedInvitation({ tenantId: TENANT_B, role: 'requester', email: 'once@example.com' });
    const acceptInvitation = await loadAction();
    // 1 回目は成功
    await acceptInvitation(rawToken, makeForm({ name: '一回目', password: 'password123' }));
    // 2 回目は消費済みのため拒否される
    await expect(
      acceptInvitation(rawToken, makeForm({ name: '二回目', password: 'password123' })),
    ).rejects.toThrow(/無効|使用/);
  });

  // 失効済みの招待は受諾できないこと
  it('失効した招待は受諾できない', async () => {
    // 既に失効した招待を用意する
    const rawToken = await seedInvitation({
      tenantId: TENANT_B,
      role: 'requester',
      email: 'expired@example.com',
      expiresAt: new Date(Date.now() - 1_000),
    });
    const acceptInvitation = await loadAction();
    // 失効済みのため拒否される
    await expect(
      acceptInvitation(rawToken, makeForm({ name: '遅刻', password: 'password123' })),
    ).rejects.toThrow(/無効|使用/);
  });

  // メール重複時はエラーになり、招待が消費されない (トランザクションでロールバック) こと
  it('メール重複時は招待を消費せずエラーにする (ロールバック)', async () => {
    // 既存ユーザーを先に登録しておく (同じメール)
    await repos.users.create({
      email: 'dup@example.com',
      name: '既存',
      passwordHash: 'x',
      role: 'requester',
      tenantId: TENANT_A,
    });
    // 同じメール宛の招待を用意する
    const rawToken = await seedInvitation({ tenantId: TENANT_B, role: 'requester', email: 'dup@example.com' });
    const tokenHash = await hashInviteToken(rawToken);
    const acceptInvitation = await loadAction();
    // 重複のため拒否される
    await expect(
      acceptInvitation(rawToken, makeForm({ name: '重複', password: 'password123' })),
    ).rejects.toThrow(/既に登録/);
    // 招待はロールバックで未消費のまま残っている (再利用可能)
    const invitation = await repos.invitations.findByTokenHash(tokenHash);
    expect(invitation?.consumedAt).toBeNull();
  });
});
