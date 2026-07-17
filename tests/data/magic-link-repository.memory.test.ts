// Vitest のテスト DSL を取り込む
import { describe, expect, it } from 'vitest';
// メモリ実装の repos/uow を組み立てるヘルパ
import { createMemoryContext } from '@/data/adapters/memory';

// 「経過時間」を表現するための定数 (テスト内で読みやすくするため)
const ONE_MINUTE = 60 * 1000;

// MagicLinkRepository (メモリ実装) の振る舞いを検証するテストスイート
describe('MagicLinkRepository (memory)', () => {
  // create: 新規発行で全フィールドが正しく保存され consumedAt が null になること
  it('create で発行したトークンは未消費 (consumedAt=null) で取得できる', async () => {
    const { repos } = createMemoryContext(); // クリーンなコンテキストを作る
    const expiresAt = new Date(Date.now() + 15 * ONE_MINUTE); // 15 分後の失効時刻
    // トークンを 1 件発行
    const created = await repos.magicLinks.create({
      email: 'user@example.com',
      tokenHash: 'hash-1',
      expiresAt,
      requestedIp: '203.0.113.42',
    });
    // 戻り値が想定どおりであることを確認
    expect(created.email).toBe('user@example.com');
    expect(created.tokenHash).toBe('hash-1');
    expect(created.consumedAt).toBeNull(); // 作成直後は未消費
    expect(created.requestedIp).toBe('203.0.113.42');

    // findByTokenHash で取り出せること
    const found = await repos.magicLinks.findByTokenHash('hash-1');
    expect(found?.id).toBe(created.id);
  });

  // findByTokenHash: 不一致のハッシュなら null を返すこと
  it('findByTokenHash で不一致ハッシュは null', async () => {
    const { repos } = createMemoryContext();
    // 一旦発行
    await repos.magicLinks.create({
      email: 'a@example.com',
      tokenHash: 'real-hash',
      expiresAt: new Date(Date.now() + ONE_MINUTE),
    });
    // 別のハッシュで引くと null
    expect(await repos.magicLinks.findByTokenHash('wrong-hash')).toBeNull();
  });

  // consumeValidToken: 未消費 + 失効前なら消費に成功し、行を返すこと
  it('consumeValidToken: 未消費 + 失効前なら 1 度だけ成功する', async () => {
    const { repos } = createMemoryContext();
    // トークン発行
    await repos.magicLinks.create({
      email: 'b@example.com',
      tokenHash: 'h-once',
      expiresAt: new Date(Date.now() + ONE_MINUTE),
    });
    const now = new Date();
    // 1 回目: 消費成功 (行を返す)
    const first = await repos.magicLinks.consumeValidToken({ tokenHash: 'h-once', now });
    expect(first).not.toBeNull();
    expect(first?.email).toBe('b@example.com');
    expect(first?.consumedAt).toBeInstanceOf(Date);

    // 2 回目: 既に消費済みなので null
    const second = await repos.magicLinks.consumeValidToken({ tokenHash: 'h-once', now });
    expect(second).toBeNull();
  });

  // consumeValidToken: 失効済みのトークンは消費できないこと
  it('consumeValidToken: 失効済みなら null を返す (消費印も立てない)', async () => {
    const { repos, store } = createMemoryContext();
    // 失効済みトークンを直接 store に投入
    store.magicLinks.set('mlt-expired', {
      id: 'mlt-expired',
      email: 'c@example.com',
      tokenHash: 'h-expired',
      expiresAt: new Date(Date.now() - ONE_MINUTE), // 1 分前に失効
      consumedAt: null,
      requestedIp: null,
      createdAt: new Date(Date.now() - 30 * ONE_MINUTE),
    });
    // 消費試行は null
    const result = await repos.magicLinks.consumeValidToken({
      tokenHash: 'h-expired',
      now: new Date(),
    });
    expect(result).toBeNull();
    // 消費印が立っていないことを確認 (失効済みの状態は変えない)
    expect(store.magicLinks.get('mlt-expired')?.consumedAt).toBeNull();
  });

  // consumeValidToken: 並行 (Promise.all) 呼び出しでも成功は 1 件のみ。ワンタイム性を保証
  it('consumeValidToken: 同時 2 回呼び出しても成功は 1 件のみ (ワンタイム性)', async () => {
    const { repos } = createMemoryContext();
    // 1 件のトークンを発行
    await repos.magicLinks.create({
      email: 'd@example.com',
      tokenHash: 'h-race',
      expiresAt: new Date(Date.now() + ONE_MINUTE),
    });
    const now = new Date();
    // 同時に 2 リクエスト分の消費を発行 (Promise.all で並行扱い)
    const [a, b] = await Promise.all([
      repos.magicLinks.consumeValidToken({ tokenHash: 'h-race', now }),
      repos.magicLinks.consumeValidToken({ tokenHash: 'h-race', now }),
    ]);
    // 結果が 1 件成功 + 1 件 null になっていることを確認 (順序は問わない)
    const successes = [a, b].filter((r) => r !== null);
    const failures = [a, b].filter((r) => r === null);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
  });

  // deleteExpired: 期限切れだけが削除され、有効分は残ること
  it('deleteExpired は失効済みのみ削除する', async () => {
    const { repos } = createMemoryContext();
    const now = new Date();
    // 失効済みを 2 件
    await repos.magicLinks.create({
      email: 'c1@example.com',
      tokenHash: 'expired-1',
      expiresAt: new Date(now.getTime() - 5 * ONE_MINUTE),
    });
    await repos.magicLinks.create({
      email: 'c2@example.com',
      tokenHash: 'expired-2',
      expiresAt: new Date(now.getTime() - 1 * ONE_MINUTE),
    });
    // 有効を 1 件
    await repos.magicLinks.create({
      email: 'c3@example.com',
      tokenHash: 'valid',
      expiresAt: new Date(now.getTime() + 10 * ONE_MINUTE),
    });
    // 期限切れ削除を実行 (削除件数は 2 件のはず)
    const removed = await repos.magicLinks.deleteExpired(now);
    expect(removed).toBe(2);
    // 有効分は残っているはず
    expect(await repos.magicLinks.findByTokenHash('valid')).not.toBeNull();
    expect(await repos.magicLinks.findByTokenHash('expired-1')).toBeNull();
  });

  // countRecentByEmail: 指定メール + since 以降の件数を正しく返すこと
  it('countRecentByEmail は同一メール宛の since 以降の件数を返す', async () => {
    const { repos, store } = createMemoryContext();
    const now = new Date();
    // 同じメール宛に古いトークンを 1 件 (createdAt を手動で過去にする)
    const old = await repos.magicLinks.create({
      email: 'rate@example.com',
      tokenHash: 'old',
      expiresAt: new Date(now.getTime() + ONE_MINUTE),
    });
    // メモリストアを直接書き換えて createdAt を 20 分前にする
    store.magicLinks.set(old.id, { ...old, createdAt: new Date(now.getTime() - 20 * ONE_MINUTE) });
    // 同じメール宛で新しいトークンを 2 件
    await repos.magicLinks.create({
      email: 'rate@example.com',
      tokenHash: 'new-1',
      expiresAt: new Date(now.getTime() + ONE_MINUTE),
    });
    await repos.magicLinks.create({
      email: 'rate@example.com',
      tokenHash: 'new-2',
      expiresAt: new Date(now.getTime() + ONE_MINUTE),
    });
    // 別メール宛は対象外
    await repos.magicLinks.create({
      email: 'other@example.com',
      tokenHash: 'unrelated',
      expiresAt: new Date(now.getTime() + ONE_MINUTE),
    });

    // 過去 15 分以内の rate@example.com 宛は 2 件
    const since = new Date(now.getTime() - 15 * ONE_MINUTE);
    expect(await repos.magicLinks.countRecentByEmail('rate@example.com', since)).toBe(2);
    // 別メールは 1 件
    expect(await repos.magicLinks.countRecentByEmail('other@example.com', since)).toBe(1);
  });

  // invalidateActiveByEmail: 監査で発見したギャップ対応。未消費・未失効のトークンを
  // 消費済み扱いにし、以後 consumeValidToken で使えなくすること
  it('invalidateActiveByEmail は未消費・未失効のトークンだけを消費済みにする', async () => {
    const { repos } = createMemoryContext();
    const now = new Date();
    // 対象: 未消費 + 未失効
    await repos.magicLinks.create({
      email: 'target@example.com',
      tokenHash: 'active',
      expiresAt: new Date(now.getTime() + 10 * ONE_MINUTE),
    });
    // 対象外: 既に消費済み
    await repos.magicLinks.create({
      email: 'target@example.com',
      tokenHash: 'already-consumed',
      expiresAt: new Date(now.getTime() + 10 * ONE_MINUTE),
    });
    await repos.magicLinks.consumeValidToken({ tokenHash: 'already-consumed', now });
    // 対象外: 別メール宛
    await repos.magicLinks.create({
      email: 'other@example.com',
      tokenHash: 'other-active',
      expiresAt: new Date(now.getTime() + 10 * ONE_MINUTE),
    });

    await repos.magicLinks.invalidateActiveByEmail('target@example.com', now);

    // 未消費・未失効だったトークンは消費済みになり、もう使えない
    expect(await repos.magicLinks.consumeValidToken({ tokenHash: 'active', now })).toBeNull();
    // 別メール宛のトークンは影響を受けない
    expect(
      await repos.magicLinks.consumeValidToken({ tokenHash: 'other-active', now }),
    ).not.toBeNull();
  });
});
