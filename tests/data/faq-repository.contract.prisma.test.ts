// FAQ リポジトリ (Prisma アダプタ) の契約テスト。
// 監査で発見したギャップ: tests/data/faq-repository.memory.test.ts (メモリアダプタ) しかテストが
// 無く、list() の include (ticket/createdBy の JOIN) や updateMany によるテナントスコープ更新が
// 本番 Prisma アダプタで実際に動くかは未検証だった (CLAUDE.md §11)。
//
// この DB 依存テストは RUN_PRISMA_CONTRACT=1 のときだけ走り、beforeEach で全テーブルを
// TRUNCATE するため **開発 DB を指さない** こと。

import { describe, beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
import { PrismaClient } from '@/generated/prisma';
import { buildPrismaRepos } from '@/data/adapters/prisma';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const AGENT_A = 'agent-a';

const SHOULD_RUN = process.env.RUN_PRISMA_CONTRACT === '1';

describe.runIf(SHOULD_RUN)('FaqRepository (prisma adapter)', () => {
  let prisma: PrismaClient;
  let ticketA: string;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "Location","Attachment","TicketHistory","TicketComment","Notification","FaqCandidate","Ticket","Category","MagicLinkToken","User","Tenant" RESTART IDENTITY CASCADE',
    );
    await prisma.tenant.create({ data: { id: TENANT_A, name: 'テナントA', mode: 'lite' } });
    await prisma.tenant.create({ data: { id: TENANT_B, name: 'テナントB', mode: 'lite' } });
    await prisma.user.create({
      data: {
        id: AGENT_A,
        email: 'agent-a@example.com',
        name: 'エージェントA',
        passwordHash: 'x',
        role: 'agent',
        tenantId: TENANT_A,
      },
    });
    const repos = buildPrismaRepos(prisma);
    const ticket = await repos.tickets.create({
      title: 'テナントAのチケット',
      body: '本文',
      priority: 'Medium',
      creatorId: AGENT_A,
      categoryId: null,
      locationId: null,
      tenantId: TENANT_A,
    });
    ticketA = ticket.id;
  });

  // 新規 FAQ 候補を作成できる (初期状態は Candidate)
  it('新規FAQ候補を作成できる', async () => {
    const repos = buildPrismaRepos(prisma);
    const faq = await repos.faq.create({
      ticketId: ticketA,
      createdById: AGENT_A,
      question: '印刷できないときは?',
      answer: '電源を確認してください',
      tenantId: TENANT_A,
    });
    expect(faq.status).toBe('Candidate');
  });

  // findById: 他テナントの ID は null (クロステナント漏洩防止)
  it('findByIdは他テナントのIDにnullを返す', async () => {
    const repos = buildPrismaRepos(prisma);
    const faq = await repos.faq.create({
      ticketId: ticketA,
      createdById: AGENT_A,
      question: 'Q',
      answer: 'A',
      tenantId: TENANT_A,
    });
    expect(await repos.faq.findById(faq.id, TENANT_B)).toBeNull();
  });

  // list: 関連チケット/作成者名を JOIN して返す (include の実 DB 動作確認)
  it('listは関連チケット・作成者名を結合して返す', async () => {
    const repos = buildPrismaRepos(prisma);
    await repos.faq.create({
      ticketId: ticketA,
      createdById: AGENT_A,
      question: 'QA',
      answer: 'AA',
      tenantId: TENANT_A,
    });
    const result = await repos.faq.list(TENANT_A);
    expect(result).toHaveLength(1);
    expect(result[0].ticket.title).toBe('テナントAのチケット');
    expect(result[0].createdBy.name).toBe('エージェントA');
  });

  // listPublished: 公開済みのみをテナントスコープで select 経由で返す (フォローアップ 2026-07-14 #5)
  it('listPublishedは公開済みのみをテナントスコープで返す', async () => {
    const repos = buildPrismaRepos(prisma);
    const published = await repos.faq.create({
      ticketId: ticketA,
      createdById: AGENT_A,
      question: '公開済みの質問',
      answer: '公開済みの回答',
      tenantId: TENANT_A,
    });
    await repos.faq.updateStatus(published.id, { from: 'Candidate', to: 'Published' }, TENANT_A);
    // 候補のまま (Candidate) の FAQ は含めない
    // (FaqCandidate.ticketId は 1 チケット 1 候補のユニーク制約があるため、別のチケットに紐付ける)
    const anotherTicket = await repos.tickets.create({
      title: 'テナントAの別チケット',
      body: '本文',
      priority: 'Medium',
      creatorId: AGENT_A,
      categoryId: null,
      locationId: null,
      tenantId: TENANT_A,
    });
    await repos.faq.create({
      ticketId: anotherTicket.id,
      createdById: AGENT_A,
      question: '候補のままの質問',
      answer: '候補のままの回答',
      tenantId: TENANT_A,
    });

    const result = await repos.faq.listPublished(TENANT_A);
    expect(result).toEqual([
      { id: published.id, question: '公開済みの質問', answer: '公開済みの回答' },
    ]);
  });

  // updateStatus: 期待状態 (from) が一致していれば tenantId スコープの updateMany が更新し true を返す
  it('updateStatusで状態を更新できる', async () => {
    const repos = buildPrismaRepos(prisma);
    const faq = await repos.faq.create({
      ticketId: ticketA,
      createdById: AGENT_A,
      question: 'Q',
      answer: 'A',
      tenantId: TENANT_A,
    });
    const updated = await repos.faq.updateStatus(
      faq.id,
      { from: 'Candidate', to: 'Published' },
      TENANT_A,
    );
    expect(updated).toBe(true);
    const reloaded = await repos.faq.findById(faq.id, TENANT_A);
    expect(reloaded?.status).toBe('Published');
  });

  // updateStatus: 他テナントの ID は no-op (updateMany が 0 件更新で false)
  it('updateStatusは他テナントのIDに対してno-opになる', async () => {
    const repos = buildPrismaRepos(prisma);
    const faq = await repos.faq.create({
      ticketId: ticketA,
      createdById: AGENT_A,
      question: 'Q',
      answer: 'A',
      tenantId: TENANT_A,
    });
    const updated = await repos.faq.updateStatus(
      faq.id,
      { from: 'Candidate', to: 'Published' },
      TENANT_B,
    );
    expect(updated).toBe(false);
    const reloaded = await repos.faq.findById(faq.id, TENANT_A);
    expect(reloaded?.status).toBe('Candidate');
  });

  // updateStatus: 期待状態 (from) が現在の状態と異なる場合は 0 件更新で false を返す
  // (フォローアップ 2026-07-15: check-then-act 競合で禁止遷移が後勝ちするのを防ぐ)
  it('updateStatusは期待状態が一致しない場合に更新せずfalseを返す', async () => {
    const repos = buildPrismaRepos(prisma);
    const faq = await repos.faq.create({
      ticketId: ticketA,
      createdById: AGENT_A,
      question: 'Q',
      answer: 'A',
      tenantId: TENANT_A,
    });
    // 先行する操作が却下済みにした想定 (Candidate → Rejected)
    await repos.faq.updateStatus(faq.id, { from: 'Candidate', to: 'Rejected' }, TENANT_A);
    // 古い読み取り (Candidate) を前提にした公開は失敗し、Rejected のまま変わらない
    const updated = await repos.faq.updateStatus(
      faq.id,
      { from: 'Candidate', to: 'Published' },
      TENANT_A,
    );
    expect(updated).toBe(false);
    const reloaded = await repos.faq.findById(faq.id, TENANT_A);
    expect(reloaded?.status).toBe('Rejected');
  });

  // updateContent: tenantId スコープの updateMany が質問/回答を正しく更新する
  // (フォローアップ 2026-07-14 #6)
  it('updateContentで質問/回答を更新できる', async () => {
    const repos = buildPrismaRepos(prisma);
    const faq = await repos.faq.create({
      ticketId: ticketA,
      createdById: AGENT_A,
      question: '元の質問',
      answer: '元の回答',
      tenantId: TENANT_A,
    });
    await repos.faq.updateContent(
      faq.id,
      { question: '新しい質問', answer: '新しい回答' },
      TENANT_A,
    );
    const reloaded = await repos.faq.findById(faq.id, TENANT_A);
    expect(reloaded?.question).toBe('新しい質問');
    expect(reloaded?.answer).toBe('新しい回答');
  });

  // updateContent: 他テナントの ID は no-op (updateMany が 0 件更新)
  it('updateContentは他テナントのIDに対してno-opになる', async () => {
    const repos = buildPrismaRepos(prisma);
    const faq = await repos.faq.create({
      ticketId: ticketA,
      createdById: AGENT_A,
      question: '元の質問',
      answer: '元の回答',
      tenantId: TENANT_A,
    });
    await repos.faq.updateContent(
      faq.id,
      { question: '書き換え試行', answer: '書き換え試行' },
      TENANT_B,
    );
    const reloaded = await repos.faq.findById(faq.id, TENANT_A);
    expect(reloaded?.question).toBe('元の質問');
    expect(reloaded?.answer).toBe('元の回答');
  });
});
