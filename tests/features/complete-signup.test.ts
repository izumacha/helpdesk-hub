// Vitest のテスト DSL とモック機能
import { beforeEach, describe, expect, it, vi } from 'vitest';
// メモリ実装の context (store/repos/uow)。buildMemoryRepos は競合エラーの回帰テストで
// tx.users.create だけを差し替えたカスタム uow を組み立てるために使う
import { buildMemoryRepos, createMemoryContext, type Store } from '@/data/adapters/memory';
// リポジトリ束 / UnitOfWork の型
import type { Repos, UnitOfWork } from '@/data/ports/unit-of-work';
// サインアップトークンのハッシュ化 (DB 保存値と同じ SHA-256 を作るために使う)
import { hashSignupToken } from '@/lib/signup';

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
// (/code-review ultra 指摘対応 2026-07-19: isSignupAcceptable は公開エンドポイント化を防ぐため
//  'use server' モジュールから @/lib/signup-acceptance へ移設)
async function loadActions() {
  const mod = await import('@/features/auth/actions/complete-signup');
  const acceptance = await import('@/lib/signup-acceptance');
  return { completeSignup: mod.completeSignup, isSignupAcceptable: acceptance.isSignupAcceptable };
}

// テストごとにクリーンな状態にする (テナントのシードは不要。complete-signup 自体がテナントを作る)
beforeEach(() => {
  const ctx = createMemoryContext();
  store = ctx.store;
  repos = ctx.repos;
  uow = ctx.uow;
});

// サインアップトークンを 1 件作成して生トークンを返すヘルパー
async function seedSignupToken(overrides: { email: string; expiresAt?: Date }): Promise<string> {
  // 生トークン (テスト内では固定文字列で十分。ハッシュ化して保存する)
  const rawToken = `raw-${overrides.email}-${Math.random()}`;
  // DB 保存値と同じ SHA-256 ハッシュへ変換する
  const tokenHash = await hashSignupToken(rawToken);
  // サインアップトークン行を作成する
  await repos.signupTokens.create({
    email: overrides.email,
    tokenHash,
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60_000),
  });
  return rawToken;
}

// FormData を組み立てるヘルパー
function makeForm(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe('completeSignup', () => {
  // トークンが指すメールで新しいテナント + 初代管理者 (admin) が作成されること
  it('サインアップトークンが指すメールで新しいテナント + 初代管理者を作成する', async () => {
    const rawToken = await seedSignupToken({ email: 'founder@example.com' });
    const { completeSignup } = await loadActions();
    const result = await completeSignup(
      rawToken,
      makeForm({
        tenantName: '株式会社サンプル',
        adminName: '創業 太郎',
        adminPassword: 'password123',
      }),
    );

    // 戻り値のメールはトークン行のメール
    expect(result.email).toBe('founder@example.com');
    // 作成されたユーザーを store から探す
    const created = [...store.users.values()].find((u) => u.email === 'founder@example.com');
    expect(created).toBeDefined();
    // 権限は常に admin (初代管理者)
    expect(created?.role).toBe('admin');
    // 新しいテナントが作られている (組織名が一致)
    const tenant = [...store.tenants.values()].find((t) => t.id === created?.tenantId);
    expect(tenant?.name).toBe('株式会社サンプル');
    // Phase 3 オンボーディング: サンプルチケットが自動投入される (create-tenant.ts と共有ロジック)
    const sampleTickets = [...store.tickets.values()].filter((t) => t.tenantId === tenant?.id);
    expect(sampleTickets.length).toBeGreaterThanOrEqual(2);
  });

  // フォローアップ (2026-07-14 #2): 監査で発見したギャップの解消。テナント作成 (新しい admin
  // 権限の付与) が監査ログに記録されること。セルフサーブサインアップには事前セッションが
  // 存在しないため、actorId は「今まさに作成された初代管理者自身」の ID になる
  // (Stripe Webhook 起因の actorId: null 「システム」とは異なり、実在する人物の操作として記録する)
  it('作成成功時に監査ログへ記録され、actorIdは作成された初代管理者自身になる', async () => {
    const rawToken = await seedSignupToken({ email: 'audit-founder@example.com' });
    const { completeSignup } = await loadActions();
    await completeSignup(
      rawToken,
      makeForm({
        tenantName: '監査確認組織',
        adminName: '監査 太郎',
        adminPassword: 'password123',
      }),
    );

    const created = [...store.users.values()].find((u) => u.email === 'audit-founder@example.com');
    const auditLogs = await repos.settingsAudit.findAllByTenant({ tenantId: created!.tenantId });
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].action).toBe('tenant_create');
    expect(auditLogs[0].actorId).toBe(created!.id);
  });

  // サインアップトークンは受諾後 (完了後) に消費済みになること
  it('完了後はサインアップトークンが消費済みになる', async () => {
    const rawToken = await seedSignupToken({ email: 'once@example.com' });
    const tokenHash = await hashSignupToken(rawToken);
    const { completeSignup } = await loadActions();
    await completeSignup(
      rawToken,
      makeForm({ tenantName: '組織A', adminName: '一回目', adminPassword: 'password123' }),
    );
    const signup = await repos.signupTokens.findByTokenHash(tokenHash);
    expect(signup?.consumedAt).not.toBeNull();
  });

  // 同じサインアップリンクは 2 回使えないこと (単回使用)
  it('同じサインアップリンクは 2 回完了できない', async () => {
    const rawToken = await seedSignupToken({ email: 'once@example.com' });
    const { completeSignup } = await loadActions();
    // 1 回目は成功
    await completeSignup(
      rawToken,
      makeForm({ tenantName: '組織A', adminName: '一回目', adminPassword: 'password123' }),
    );
    // 2 回目は消費済みのため拒否される
    await expect(
      completeSignup(
        rawToken,
        makeForm({ tenantName: '組織B', adminName: '二回目', adminPassword: 'password123' }),
      ),
    ).rejects.toThrow(/無効|使用/);
  });

  // 失効済みのサインアップリンクは完了できないこと
  it('失効したサインアップリンクは完了できない', async () => {
    const rawToken = await seedSignupToken({
      email: 'expired@example.com',
      expiresAt: new Date(Date.now() - 1_000),
    });
    const { completeSignup } = await loadActions();
    await expect(
      completeSignup(
        rawToken,
        makeForm({ tenantName: '組織C', adminName: '遅刻', adminPassword: 'password123' }),
      ),
    ).rejects.toThrow(/無効|使用/);
  });

  // メール重複時 (例: 発行後に別経路で同じメールが登録された) はエラーになり、
  // サインアップトークンが消費されない (ロールバック) こと
  it('メール重複時はサインアップトークンを消費せずエラーにする (ロールバック)', async () => {
    // 既存ユーザーを先に登録しておく (同じメール。別テナント経由の招待受諾等を想定)
    await repos.users.create({
      email: 'dup@example.com',
      name: '既存',
      passwordHash: 'x',
      role: 'requester',
      tenantId: (await repos.tenants.create({ name: '既存組織', industry: null })).id,
    });
    const rawToken = await seedSignupToken({ email: 'dup@example.com' });
    const tokenHash = await hashSignupToken(rawToken);
    const { completeSignup } = await loadActions();
    await expect(
      completeSignup(
        rawToken,
        makeForm({ tenantName: '組織D', adminName: '重複', adminPassword: 'password123' }),
      ),
    ).rejects.toThrow(/既に登録/);
    // サインアップトークンはロールバックで未消費のまま残っている
    const signup = await repos.signupTokens.findByTokenHash(tokenHash);
    expect(signup?.consumedAt).toBeNull();
  });

  // /code-review ultra 指摘対応 (accept-invitation.ts の前例): 事前の findByEmail 重複チェックを
  // すり抜けて (= 同時完了レース) tx.users.create が DB の一意制約違反を投げても、Prisma の
  // 生エラー文言をクライアントへそのまま返さず、事前チェックと同じ安全な日本語メッセージに
  // 変換されること (§9: 内部エラー文言の非漏洩)
  it('メール一意制約違反がレースで競合しても生のエラー文言を返さない', async () => {
    const rawToken = await seedSignupToken({ email: 'race@example.com' });
    // tx.users.create だけを差し替えたカスタム uow (それ以外は通常のメモリ実装のまま)
    uow = {
      async run(fn) {
        const tx = buildMemoryRepos(store);
        tx.users.create = async () => {
          // Prisma の一意制約違反エラーを模した生メッセージ (DB スキーマ情報を含む想定)
          throw new Error('Unique constraint failed on the fields: (`email`)');
        };
        return fn(tx);
      },
      isTransactionConflict: () => false,
    };

    const { completeSignup } = await loadActions();
    const err: unknown = await completeSignup(
      rawToken,
      makeForm({ tenantName: '組織E', adminName: 'レース太郎', adminPassword: 'password123' }),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/既に登録/);
    expect((err as Error).message).not.toMatch(/email`|Unique constraint/);
  });

  // 入力検証: 組織名が空なら拒否されること
  it('組織名が空なら例外を投げる', async () => {
    const rawToken = await seedSignupToken({ email: 'novalid@example.com' });
    const { completeSignup } = await loadActions();
    await expect(
      completeSignup(
        rawToken,
        makeForm({ tenantName: '', adminName: '名前', adminPassword: 'password123' }),
      ),
    ).rejects.toThrow(/組織名/);
  });
});

describe('isSignupAcceptable', () => {
  // 未消費 + 失効前なら true
  it('未消費 + 失効前なら true を返す', async () => {
    const rawToken = await seedSignupToken({ email: 'ok@example.com' });
    const { isSignupAcceptable } = await loadActions();
    expect(await isSignupAcceptable(rawToken)).toBe(true);
  });

  // 存在しないトークンは false
  it('存在しないトークンは false を返す', async () => {
    const { isSignupAcceptable } = await loadActions();
    expect(await isSignupAcceptable('no-such-token')).toBe(false);
  });

  // 失効済みは false
  it('失効済みトークンは false を返す', async () => {
    const rawToken = await seedSignupToken({
      email: 'expired2@example.com',
      expiresAt: new Date(Date.now() - 1_000),
    });
    const { isSignupAcceptable } = await loadActions();
    expect(await isSignupAcceptable(rawToken)).toBe(false);
  });

  // 使用済みは false (かつこの読み取り専用チェック自体は消費しない)
  it('使用済みトークンは false を返す (読み取り専用で消費しない)', async () => {
    const rawToken = await seedSignupToken({ email: 'used@example.com' });
    const { completeSignup, isSignupAcceptable } = await loadActions();
    await completeSignup(
      rawToken,
      makeForm({ tenantName: '組織F', adminName: '使用済み', adminPassword: 'password123' }),
    );
    expect(await isSignupAcceptable(rawToken)).toBe(false);
  });
});
