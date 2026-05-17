// Vitest のテスト DSL とモック機能
import { beforeEach, describe, expect, it, vi } from 'vitest';
// メモリ実装の context (store/repos)
import { createMemoryContext, type Store } from '@/data/adapters/memory';
// リポジトリ束の型
import type { Repos } from '@/data/ports/unit-of-work';
// EmailSender 型 (fake 実装で利用)
import type { EmailSender } from '@/lib/email';
// マジックリンク URL 構築 (fake send 内で URL に含まれるトークンを取り出すために使う)
import { hashMagicLinkToken } from '@/lib/magic-link';

// 各テスト前に書き換える依存。Action import 前に getter で参照させる
let store: Store;
let repos: Repos;
// EmailSender への呼び出しを記録するフェイク
let sentMessages: { to: string; subject: string; html: string; text: string }[] = [];

// @/data を差し替え。getter で参照することで、テスト中の上書きが反映される
vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
}));

// EmailSender ファクトリを差し替え。sentMessages に記録するだけのフェイクを返す
vi.mock('@/lib/email', () => ({
  getEmailSender: (): EmailSender => ({
    async send(message) {
      // 呼び出し内容を配列に記録 (後でアサート)
      sentMessages.push(message);
    },
  }),
}));

// 動的 import: 上のモック設定が反映された後で対象を読み込む
async function loadAction() {
  const mod = await import('@/features/auth/actions/request-magic-link');
  return mod.requestMagicLink;
}

// テストごとにクリーンな状態にする
beforeEach(() => {
  const ctx = createMemoryContext();
  store = ctx.store;
  repos = ctx.repos;
  sentMessages = [];
  // テナントを 1 つ用意 (User の FK 先として必要)
  store.tenants.set('default-tenant', {
    id: 'default-tenant',
    name: 'デフォルト組織',
    mode: 'lite',
    industry: null,
    createdAt: new Date(),
  });
});

describe('requestMagicLink', () => {
  // 既知ユーザーへ送信されること + DB にはハッシュのみが保存されること
  it('既知ユーザー宛にメールが送信され、ハッシュのみが DB に保存される', async () => {
    // ユーザーを seed
    store.users.set('u-1', {
      id: 'u-1',
      email: 'requester1@example.com',
      name: '依頼者1',
      passwordHash: 'x',
      role: 'requester',
      tenantId: 'default-tenant',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Action 呼び出し
    const requestMagicLink = await loadAction();
    const result = await requestMagicLink({ email: 'requester1@example.com' });

    // 戻り値は常に ok
    expect(result).toEqual({ ok: true });
    // メールが 1 件送信されている
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].to).toBe('requester1@example.com');
    // URL がメール本文に含まれる
    const match = sentMessages[0].text.match(/https?:\/\/\S+token=([A-Za-z0-9_-]+)/);
    expect(match).not.toBeNull();
    const rawTokenFromEmail = match![1];

    // DB にはハッシュが 1 件保存されている (生トークンは保存されていない)
    expect(store.magicLinks.size).toBe(1);
    const stored = [...store.magicLinks.values()][0];
    expect(stored.tokenHash).toBe(hashMagicLinkToken(rawTokenFromEmail));
    expect(stored.tokenHash).not.toBe(rawTokenFromEmail);
    expect(stored.consumedAt).toBeNull();
    // 失効時刻は今より未来 (約 15 分後) であること
    expect(stored.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  // 未登録メールでもエラーは投げず、メールも送らないこと (列挙対策)
  it('未登録メールに対しても ok を返し、メールは送らない', async () => {
    const requestMagicLink = await loadAction();
    const result = await requestMagicLink({ email: 'unknown@example.com' });
    // 戻り値は常に ok
    expect(result).toEqual({ ok: true });
    // メールは送られていない
    expect(sentMessages).toHaveLength(0);
    // DB にも何も保存されていない
    expect(store.magicLinks.size).toBe(0);
  });

  // メールアドレスが大文字小文字混在でも DB は小文字で保存されること
  it('入力メールを小文字に正規化して扱う', async () => {
    // 小文字で seed
    store.users.set('u-1', {
      id: 'u-1',
      email: 'mixed@example.com',
      name: 'm',
      passwordHash: 'x',
      role: 'requester',
      tenantId: 'default-tenant',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const requestMagicLink = await loadAction();
    // 大文字混じりで呼び出し
    await requestMagicLink({ email: 'Mixed@Example.COM' });

    // 1 件発行され、email は小文字化されている
    expect(store.magicLinks.size).toBe(1);
    expect([...store.magicLinks.values()][0].email).toBe('mixed@example.com');
  });

  // 不正なメール形式は例外で弾かれること
  it('メール形式が不正なら例外を投げる', async () => {
    const requestMagicLink = await loadAction();
    await expect(requestMagicLink({ email: 'not-an-email' })).rejects.toThrow(
      /メールアドレス/,
    );
  });

  // 期限切れトークンが掃除されること
  it('呼び出し時に失効済みトークンを掃除する', async () => {
    // ユーザー seed
    store.users.set('u-1', {
      id: 'u-1',
      email: 'a@example.com',
      name: 'a',
      passwordHash: 'x',
      role: 'requester',
      tenantId: 'default-tenant',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // 失効済みトークンを 1 件、有効を 1 件、ストア直接投入
    const now = Date.now();
    store.magicLinks.set('mlt-old', {
      id: 'mlt-old',
      email: 'a@example.com',
      tokenHash: 'old-hash',
      expiresAt: new Date(now - 60_000),
      consumedAt: null,
      requestedIp: null,
      createdAt: new Date(now - 30 * 60_000),
    });
    store.magicLinks.set('mlt-ok', {
      id: 'mlt-ok',
      email: 'a@example.com',
      tokenHash: 'ok-hash',
      expiresAt: new Date(now + 5 * 60_000),
      consumedAt: null,
      requestedIp: null,
      createdAt: new Date(now - 1 * 60_000),
    });
    // Action 呼び出し (これで掃除 + 新規発行が起きる)
    const requestMagicLink = await loadAction();
    await requestMagicLink({ email: 'a@example.com' });

    // 失効済みは消えている、有効分は残る、新規発行 1 件で計 2 件
    expect(store.magicLinks.has('mlt-old')).toBe(false);
    expect(store.magicLinks.has('mlt-ok')).toBe(true);
    expect(store.magicLinks.size).toBe(2);
  });
});
