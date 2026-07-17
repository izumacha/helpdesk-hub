// マジックリンクトークンリポジトリ (Prisma アダプタ) の契約テスト。
// 監査で発見したギャップ: MagicLinkRepository はメモリアダプタのテスト
// (magic-link-repository.memory.test.ts) しか無く、認証に直結する
// consumeValidToken (パスワードレスログインの単回使用保証) が本番 Prisma アダプタで
// 実際に機能するかは未検証だった。特に consumeValidToken は「未消費 かつ 失効前」の
// 行だけを原子的に更新する単一 UPDATE (updateMany) に依存しており、この単回使用の
// 保証が PostgreSQL の行ロックの上で実際に成立するかは実 DB でしか検証できない
// (メモリアダプタの Promise.all はシングルスレッド JS の擬似並行に過ぎない)。
//
// MagicLinkToken は tenantId を持たない (メール宛の一時トークンでテナント非依存) ため、
// 他の契約テストと異なり Tenant/User のシードは不要。
//
// この DB 依存テストは RUN_PRISMA_CONTRACT=1 のときだけ走り、beforeEach で全テーブルを
// TRUNCATE するため **開発 DB を指さない** こと (CLAUDE.md §テスト)。

import { describe, beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
import { PrismaClient } from '@/generated/prisma';
import { buildPrismaRepos } from '@/data/adapters/prisma';

// 「経過時間」を表現するための定数 (テスト内で読みやすくするため)
const ONE_MINUTE = 60 * 1000;

const SHOULD_RUN = process.env.RUN_PRISMA_CONTRACT === '1';

describe.runIf(SHOULD_RUN)('MagicLinkRepository (prisma adapter)', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    // Prisma クライアントを生成する
    prisma = new PrismaClient();
    // DB へ接続する
    await prisma.$connect();
  });

  afterAll(async () => {
    // DB 接続を閉じる
    await prisma.$disconnect();
  });

  // 各テスト前に関連テーブルを空にする (MagicLinkToken は tenantId 非依存なので単独で足りる)
  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "MagicLinkToken" RESTART IDENTITY CASCADE');
  });

  // create + findByTokenHash: 発行したトークンを未消費のまま取得できる
  it('createで発行したトークンは未消費 (consumedAt=null) でfindByTokenHashから取得できる', async () => {
    // 本番 Prisma アダプタの repos を組み立てる
    const repos = buildPrismaRepos(prisma);
    // 15 分後を失効時刻とする
    const expiresAt = new Date(Date.now() + 15 * ONE_MINUTE);
    // トークンを 1 件発行する
    const created = await repos.magicLinks.create({
      email: 'user@example.com',
      tokenHash: 'hash-1',
      expiresAt,
      requestedIp: '203.0.113.42',
    });
    // 作成直後は未消費 (consumedAt が null) であること
    expect(created.consumedAt).toBeNull();
    // 発行元 IP が保存されていること
    expect(created.requestedIp).toBe('203.0.113.42');

    // tokenHash で同じ行を引けること
    const found = await repos.magicLinks.findByTokenHash('hash-1');
    expect(found?.id).toBe(created.id);
  });

  // consumeValidToken: 未消費 + 失効前なら消費に成功し、2回目は null になる (単回使用)
  it('consumeValidTokenは未消費+失効前なら1度だけ成功する', async () => {
    // 本番 Prisma アダプタの repos を組み立てる
    const repos = buildPrismaRepos(prisma);
    // 消費対象のトークンを 1 件発行する
    await repos.magicLinks.create({
      email: 'b@example.com',
      tokenHash: 'h-once',
      expiresAt: new Date(Date.now() + ONE_MINUTE),
    });
    // 消費時刻として使う現在時刻
    const now = new Date();
    // 1 回目の消費: 成功して行が返るはず
    const first = await repos.magicLinks.consumeValidToken({ tokenHash: 'h-once', now });
    expect(first?.email).toBe('b@example.com');
    expect(first?.consumedAt).toBeInstanceOf(Date);

    // 2回目は既に消費済みなので null
    const second = await repos.magicLinks.consumeValidToken({ tokenHash: 'h-once', now });
    expect(second).toBeNull();
  });

  // consumeValidToken: 失効済みのトークンは消費できず、消費印も立たない
  it('consumeValidTokenは失効済みならnullを返し消費印も立てない', async () => {
    // 本番 Prisma アダプタの repos を組み立てる
    const repos = buildPrismaRepos(prisma);
    // 既に失効済みのトークンを発行する
    await repos.magicLinks.create({
      email: 'c@example.com',
      tokenHash: 'h-expired',
      expiresAt: new Date(Date.now() - ONE_MINUTE), // 既に失効
    });
    // 失効済みトークンの消費を試みる
    const result = await repos.magicLinks.consumeValidToken({
      tokenHash: 'h-expired',
      now: new Date(),
    });
    // 消費に失敗して null が返ること
    expect(result).toBeNull();
    // 消費印が立っていないこと (findByTokenHash で直接確認)
    const row = await repos.magicLinks.findByTokenHash('h-expired');
    expect(row?.consumedAt).toBeNull();
  });

  // consumeValidToken: 同時 2 リクエストでも実 DB の行ロックにより成功は 1 件のみ
  // (updateMany による単一 UPDATE 文の原子性を PostgreSQL に対して検証する最重要ケース)
  it('consumeValidTokenは同時2リクエストでも実DBの行ロックにより成功が1件のみになる', async () => {
    // 本番 Prisma アダプタの repos を組み立てる
    const repos = buildPrismaRepos(prisma);
    // 競合させるトークンを 1 件発行する
    await repos.magicLinks.create({
      email: 'd@example.com',
      tokenHash: 'h-race',
      expiresAt: new Date(Date.now() + ONE_MINUTE),
    });
    // 両リクエストで共有する消費時刻
    const now = new Date();
    // Promise.all で 2 件の消費要求を同時に DB へ送る (真の並行リクエスト)
    const [a, b] = await Promise.all([
      repos.magicLinks.consumeValidToken({ tokenHash: 'h-race', now }),
      repos.magicLinks.consumeValidToken({ tokenHash: 'h-race', now }),
    ]);
    // 成功 (null でない) 側を抽出する
    const successes = [a, b].filter((r) => r !== null);
    // 失敗 (null) 側を抽出する
    const failures = [a, b].filter((r) => r === null);
    // 成功はちょうど 1 件だけであること
    expect(successes).toHaveLength(1);
    // 失敗もちょうど 1 件だけであること
    expect(failures).toHaveLength(1);
  });

  // deleteById: 指定IDを物理削除する (rollback用)。存在しないIDでも例外を投げない
  it('deleteByIdは指定IDを削除し存在しないIDでも例外を投げない', async () => {
    // 本番 Prisma アダプタの repos を組み立てる
    const repos = buildPrismaRepos(prisma);
    // 削除対象のトークンを 1 件発行する
    const created = await repos.magicLinks.create({
      email: 'e@example.com',
      tokenHash: 'h-delete',
      expiresAt: new Date(Date.now() + ONE_MINUTE),
    });
    // 発行したトークンを削除する
    await repos.magicLinks.deleteById(created.id);
    // 削除後は findByTokenHash で見つからないこと
    expect(await repos.magicLinks.findByTokenHash('h-delete')).toBeNull();
    // 存在しない ID でも例外を投げない (P2025 を避けて deleteMany を使う設計の確認)
    await expect(repos.magicLinks.deleteById('no-such-id')).resolves.not.toThrow();
  });

  // deleteExpired: 期限切れのみ削除され、有効分は残る
  it('deleteExpiredは失効済みのみ削除する', async () => {
    // 本番 Prisma アダプタの repos を組み立てる
    const repos = buildPrismaRepos(prisma);
    // 基準となる現在時刻
    const now = new Date();
    // 既に失効済みのトークンを発行する
    await repos.magicLinks.create({
      email: 'f1@example.com',
      tokenHash: 'expired-1',
      expiresAt: new Date(now.getTime() - 5 * ONE_MINUTE),
    });
    // まだ有効なトークンを発行する
    await repos.magicLinks.create({
      email: 'f2@example.com',
      tokenHash: 'valid',
      expiresAt: new Date(now.getTime() + 10 * ONE_MINUTE),
    });
    // 期限切れ一括削除を実行する
    const removed = await repos.magicLinks.deleteExpired(now);
    // 削除件数は 1 件のはず (失効済みの 1 件のみ)
    expect(removed).toBe(1);
    // 有効なトークンは残っていること
    expect(await repos.magicLinks.findByTokenHash('valid')).not.toBeNull();
    // 失効済みトークンは削除されていること
    expect(await repos.magicLinks.findByTokenHash('expired-1')).toBeNull();
  });

  // countRecentByEmail: 指定メール + since 以降の件数を正しく返す (発行レート制限用)
  it('countRecentByEmailは同一メール宛のsince以降の件数を返す', async () => {
    // 本番 Prisma アダプタの repos を組み立てる
    const repos = buildPrismaRepos(prisma);
    // 基準となる現在時刻
    const now = new Date();
    // 古いトークンを 1 件発行する (後で createdAt を過去にずらす)
    const old = await repos.magicLinks.create({
      email: 'rate@example.com',
      tokenHash: 'old',
      expiresAt: new Date(now.getTime() + ONE_MINUTE),
    });
    // createdAt は @default(now()) のため、20分前相当に見せるよう生SQLで更新する
    await prisma.magicLinkToken.update({
      where: { id: old.id },
      data: { createdAt: new Date(now.getTime() - 20 * ONE_MINUTE) },
    });
    // 同じメール宛に新しいトークンを 1 件発行する
    await repos.magicLinks.create({
      email: 'rate@example.com',
      tokenHash: 'new-1',
      expiresAt: new Date(now.getTime() + ONE_MINUTE),
    });
    // 別メール宛のトークンも 1 件発行する (対象外であることの確認用)
    await repos.magicLinks.create({
      email: 'other@example.com',
      tokenHash: 'unrelated',
      expiresAt: new Date(now.getTime() + ONE_MINUTE),
    });

    // 過去 15 分以内を対象とする基準時刻
    const since = new Date(now.getTime() - 15 * ONE_MINUTE);
    // rate@example.com 宛の過去15分以内は new-1 の1件のみ (old は範囲外)
    expect(await repos.magicLinks.countRecentByEmail('rate@example.com', since)).toBe(1);
    // other@example.com 宛は 1 件
    expect(await repos.magicLinks.countRecentByEmail('other@example.com', since)).toBe(1);
  });

  // invalidateActiveByEmail: 監査で発見したギャップ対応。未消費・未失効のトークンを
  // 消費済み扱いにし、以後 consumeValidToken で使えなくすること
  it('invalidateActiveByEmailは未消費・未失効のトークンだけを消費済みにする', async () => {
    const repos = buildPrismaRepos(prisma);
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
