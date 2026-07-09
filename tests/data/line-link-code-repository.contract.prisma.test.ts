// LINE 連携コード冪等化記録リポジトリ (本番 Prisma 実装) の契約テスト。
// 処理済み判定・冪等な記録 (unique 制約 + skipDuplicates) を実 DB で検証する。
// RUN_PRISMA_CONTRACT=1 のときだけ走り、beforeEach で対象テーブルを TRUNCATE するため
// **開発 DB を指さないこと** (CLAUDE.md §テスト)。専用 DB で実行する。

import { describe, beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
import { PrismaClient } from '@/generated/prisma';
import { buildPrismaRepos } from '@/data/adapters/prisma';

// DB 依存テストを実行してよいかの明示フラグ (CI の専用ジョブだけが '1' を立てる)
const SHOULD_RUN = process.env.RUN_PRISMA_CONTRACT === '1';

describe.runIf(SHOULD_RUN)('LineLinkCodeRef prisma adapter', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // LineLinkCodeRef は他テーブルへの FK を持たないため単体で TRUNCATE すればよい
  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "LineLinkCodeRef" RESTART IDENTITY CASCADE');
  });

  // 未記録の messageId は未処理と判定される
  it('未記録のmessageIdは未処理と判定する', async () => {
    const repos = buildPrismaRepos(prisma);
    expect(await repos.lineLinkCodes.wasProcessed('msg-1')).toBe(false);
  });

  // 記録した messageId は処理済みと判定される
  it('記録したmessageIdは処理済みと判定する', async () => {
    const repos = buildPrismaRepos(prisma);
    await repos.lineLinkCodes.markProcessed('msg-1');
    expect(await repos.lineLinkCodes.wasProcessed('msg-1')).toBe(true);
  });

  // 同一 messageId の二重記録は冪等 (createMany skipDuplicates で unique 制約違反にならない)
  it('同一messageIdの二重記録は冪等', async () => {
    const repos = buildPrismaRepos(prisma);
    await repos.lineLinkCodes.markProcessed('msg-1');
    await repos.lineLinkCodes.markProcessed('msg-1');
    expect(await prisma.lineLinkCodeRef.count()).toBe(1);
  });
});
