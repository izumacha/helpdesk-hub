// メールスレッド対応表リポジトリ (本番 Prisma 実装) の契約テスト。
// Message-ID → チケットの逆引き・冪等登録・クロステナント分離 (§9) を実 DB で検証する。
// RUN_PRISMA_CONTRACT=1 のときだけ走り、beforeEach で全テーブルを TRUNCATE するため
// **開発 DB を指さないこと** (CLAUDE.md §テスト)。専用 DB で実行する。

// Vitest の DSL とフック
import { describe, beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
// Prisma クライアント本体 (生成物)
import { PrismaClient } from '@/generated/prisma';
// 本番 Prisma 実装の repos 束 / UnitOfWork を組み立てる関数
import { buildPrismaRepos, buildPrismaUow } from '@/data/adapters/prisma';

// テナント A / B の ID
const TENANT_A = 'default-tenant';
const TENANT_B = 'tenant-b';

// DB 依存テストを実行してよいかの明示フラグ (CI の専用ジョブだけが '1' を立てる)
const SHOULD_RUN = process.env.RUN_PRISMA_CONTRACT === '1';

describe.runIf(SHOULD_RUN)('EmailThreadRef prisma adapter', () => {
  // スイート全体で共有する PrismaClient
  let prisma: PrismaClient;

  // スイート開始時に 1 度だけ接続する
  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
  });

  // スイート終了時に接続を閉じる (接続リーク防止)
  afterAll(async () => {
    await prisma.$disconnect();
  });

  // 各テスト前に全テーブルを空にし、テナント A/B とそれぞれのチケットをシードする。
  // EmailThreadRef は Tenant/Ticket への CASCADE FK があるため、Tenant TRUNCATE で連鎖的に消える。
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "EmailThreadRef","Attachment","TicketHistory","TicketComment","Notification","FaqCandidate","Ticket","Category","Invitation","MagicLinkToken","User","Tenant" RESTART IDENTITY CASCADE',
    );
    // テナント A / B を作成する
    await prisma.tenant.create({ data: { id: TENANT_A, name: 'デフォルト組織', mode: 'lite' } });
    await prisma.tenant.create({ data: { id: TENANT_B, name: '別組織', mode: 'lite' } });
    // 各テナントに 1 人ユーザーと 1 件チケットを用意する (EmailThreadRef の FK 先)
    for (const [tenantId, suffix] of [
      [TENANT_A, 'a'],
      [TENANT_B, 'b'],
    ] as const) {
      await prisma.user.create({
        data: {
          id: `u-${suffix}`,
          email: `user-${suffix}@example.com`,
          name: `ユーザー${suffix}`,
          passwordHash: 'x',
          role: 'requester',
          tenantId,
        },
      });
      await prisma.ticket.create({
        data: {
          id: `t-${suffix}`,
          title: '件名',
          body: '本文',
          creatorId: `u-${suffix}`,
          tenantId,
        },
      });
    }
  });

  // 登録した Message-ID から ticketId を逆引きできる
  it('登録した Message-ID からチケットを逆引きできる', async () => {
    const repos = buildPrismaRepos(prisma);
    await repos.emailThreads.register({
      messageId: 'm1@x.com',
      ticketId: 't-a',
      tenantId: TENANT_A,
    });
    expect(await repos.emailThreads.findTicketIdByMessageIds(['m1@x.com'], TENANT_A)).toBe('t-a');
  });

  // 同一 (tenant, messageId) の二重登録は冪等 (createMany skipDuplicates)
  it('同一 Message-ID の二重登録は冪等', async () => {
    const repos = buildPrismaRepos(prisma);
    await repos.emailThreads.register({
      messageId: 'm1@x.com',
      ticketId: 't-a',
      tenantId: TENANT_A,
    });
    // 2 回目も例外を投げず、件数は 1 のまま
    await repos.emailThreads.register({
      messageId: 'm1@x.com',
      ticketId: 't-a',
      tenantId: TENANT_A,
    });
    expect(await prisma.emailThreadRef.count()).toBe(1);
  });

  // 別テナントの Message-ID は突き合わせ対象にしない (クロステナント遮断)
  it('別テナントの Message-ID は逆引きできない', async () => {
    const repos = buildPrismaRepos(prisma);
    // テナント B に登録した Message-ID は…
    await repos.emailThreads.register({
      messageId: 'm1@x.com',
      ticketId: 't-b',
      tenantId: TENANT_B,
    });
    // テナント A のスコープでは見つからない
    expect(await repos.emailThreads.findTicketIdByMessageIds(['m1@x.com'], TENANT_A)).toBeNull();
    // 自テナント (B) では引ける
    expect(await repos.emailThreads.findTicketIdByMessageIds(['m1@x.com'], TENANT_B)).toBe('t-b');
  });

  // 別テナントが同じ Message-ID を使っても衝突しない ((tenantId, messageId) 複合一意のため)
  it('テナントが違えば同一 Message-ID を別々に登録できる', async () => {
    const repos = buildPrismaRepos(prisma);
    await repos.emailThreads.register({
      messageId: 'same@x.com',
      ticketId: 't-a',
      tenantId: TENANT_A,
    });
    await repos.emailThreads.register({
      messageId: 'same@x.com',
      ticketId: 't-b',
      tenantId: TENANT_B,
    });
    expect(await prisma.emailThreadRef.count()).toBe(2);
  });

  // 同一 Message-ID に対する「確認 → 起票 → 登録」が完全に同時実行されても、Serializable
  // 分離レベルなら書き込み競合が検知されて片方が中断され、二重起票にならないことを検証する。
  // src/app/api/inbound/email/route.ts の createEmailTicketIdempotent が依拠する DB 側の保証。
  it('Serializable トランザクションが同時実行の書き込み競合を検知し二重起票を防ぐ', async () => {
    const uow = buildPrismaUow(prisma);
    const messageId = 'race-1@x.com';

    // createEmailTicketIdempotent と同じ形の「確認 → 起票 → 登録」を 1 トランザクションで行う
    const attempt = () =>
      uow.run(
        async (tx) => {
          const already = await tx.emailThreads.findTicketIdByMessageIds([messageId], TENANT_A);
          if (already) return { id: already, alreadyExisted: true };
          // 両方の試行が「まだ無い」を読んだ直後にここで少し待つことで、読み取りタイミングを
          // 揃え、書き込み競合を確実に起こす (待ちが無いと片方が先に完了してしまい得る)
          await new Promise((resolve) => setTimeout(resolve, 100));
          const created = await tx.tickets.create({
            title: '同時実行テスト',
            body: '本文',
            priority: 'Medium',
            categoryId: null,
            creatorId: 'u-a',
            tenantId: TENANT_A,
          });
          await tx.emailThreads.register({
            messageId,
            ticketId: created.id,
            tenantId: TENANT_A,
          });
          return { id: created.id, alreadyExisted: false };
        },
        { isolationLevel: 'Serializable' },
      );

    // 2 つの試行を完全に同時実行する
    const results = await Promise.allSettled([attempt(), attempt()]);

    // ちょうど 1 件が成功し、もう 1 件は書き込み競合で失敗する
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // 失敗した方は uow.isTransactionConflict が true と判定するエラーであること
    expect(uow.isTransactionConflict((rejected[0] as PromiseRejectedResult).reason)).toBe(true);

    // DB 上にはチケット・対応表とも 1 件ずつしか作られていない (二重起票していない)
    expect(
      await prisma.ticket.count({ where: { tenantId: TENANT_A, title: '同時実行テスト' } }),
    ).toBe(1);
    expect(await prisma.emailThreadRef.count({ where: { messageId } })).toBe(1);
  });
});
