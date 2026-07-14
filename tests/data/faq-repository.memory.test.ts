// FAQ リポジトリ (メモリアダプタ) の単体テスト。
// 監査で発見したギャップ: FaqRepository には Port/Prisma/メモリの各アダプタが揃っているのに
// テストが 1 つも無かった。findById/updateStatus のテナントスコープ (クロステナント漏洩防止)
// と、list() が関連チケット/作成者を正しく結合することを検証する。

import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryContext, type Store } from '@/data/adapters/memory';
import type { Repos } from '@/data/ports/unit-of-work';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const AGENT_A = 'agent-a';

let store: Store;
let repos: Repos;

// FAQ 候補の元になるチケット + 作成者を 1 セット、指定テナントに用意する
async function seedTicketAndAgent(tenantId: string, ticketTitle: string, agentId: string) {
  const now = new Date();
  store.users.set(agentId, {
    id: agentId,
    email: `${agentId}@example.com`,
    name: agentId,
    passwordHash: 'x',
    role: 'agent',
    tenantId,
    createdAt: now,
    updatedAt: now,
  });
  const ticket = await repos.tickets.create({
    title: ticketTitle,
    body: '本文',
    priority: 'Medium',
    creatorId: agentId,
    categoryId: null,
    locationId: null,
    tenantId,
  });
  return ticket;
}

beforeEach(() => {
  const ctx = createMemoryContext();
  store = ctx.store;
  repos = ctx.repos;
});

describe('FaqRepository (memory)', () => {
  // create: 新規 FAQ 候補を作成でき、初期状態は Candidate
  it('新規FAQ候補を作成できる (初期状態はCandidate)', async () => {
    const ticket = await seedTicketAndAgent(TENANT_A, '印刷できない', AGENT_A);
    const faq = await repos.faq.create({
      ticketId: ticket.id,
      createdById: AGENT_A,
      question: '印刷できないときは?',
      answer: '電源を確認してください',
      tenantId: TENANT_A,
    });
    expect(faq.status).toBe('Candidate');
    expect(faq.tenantId).toBe(TENANT_A);
  });

  // findById: 他テナントの ID は null (クロステナント漏洩防止)
  it('findByIdは他テナントのIDにnullを返す', async () => {
    const ticket = await seedTicketAndAgent(TENANT_A, 'A', AGENT_A);
    const faq = await repos.faq.create({
      ticketId: ticket.id,
      createdById: AGENT_A,
      question: 'Q',
      answer: 'A',
      tenantId: TENANT_A,
    });
    const result = await repos.faq.findById(faq.id, TENANT_B);
    expect(result).toBeNull();
  });

  // list: テナントスコープで絞り込み、関連チケット/作成者名を結合して返す
  it('listは自テナントのFAQのみ関連情報付きで返す', async () => {
    const ticketA = await seedTicketAndAgent(TENANT_A, 'テナントAの問い合わせ', AGENT_A);
    await repos.faq.create({
      ticketId: ticketA.id,
      createdById: AGENT_A,
      question: 'QA',
      answer: 'AA',
      tenantId: TENANT_A,
    });
    const agentB = 'agent-b';
    const ticketB = await seedTicketAndAgent(TENANT_B, 'テナントBの問い合わせ', agentB);
    await repos.faq.create({
      ticketId: ticketB.id,
      createdById: agentB,
      question: 'QB',
      answer: 'AB',
      tenantId: TENANT_B,
    });

    const result = await repos.faq.list(TENANT_A);
    expect(result).toHaveLength(1);
    expect(result[0].ticket.title).toBe('テナントAの問い合わせ');
    expect(result[0].createdBy.name).toBe(AGENT_A);
  });

  // list: 新しい順に並べる
  it('listは新しい順に並べる', async () => {
    const ticket = await seedTicketAndAgent(TENANT_A, 'チケット', AGENT_A);
    const first = await repos.faq.create({
      ticketId: ticket.id,
      createdById: AGENT_A,
      question: 'Q1',
      answer: 'A1',
      tenantId: TENANT_A,
    });
    // 作成日時を確実にずらす
    await new Promise((r) => setTimeout(r, 2));
    const second = await repos.faq.create({
      ticketId: ticket.id,
      createdById: AGENT_A,
      question: 'Q2',
      answer: 'A2',
      tenantId: TENANT_A,
    });
    const result = await repos.faq.list(TENANT_A);
    expect(result.map((f) => f.id)).toEqual([second.id, first.id]);
  });

  // listPublished: 公開済み (Published) のみを返し、Candidate/Rejected は含めない
  // (フォローアップ 2026-07-14 #5: 依頼者向け公開 FAQ 閲覧用)
  it('listPublishedは公開済みのみをテナントスコープで返す', async () => {
    const ticket = await seedTicketAndAgent(TENANT_A, 'チケット', AGENT_A);
    const published = await repos.faq.create({
      ticketId: ticket.id,
      createdById: AGENT_A,
      question: '公開済みの質問',
      answer: '公開済みの回答',
      tenantId: TENANT_A,
    });
    await repos.faq.updateStatus(published.id, 'Published', TENANT_A);
    // 候補のまま (Candidate) の FAQ も同テナントに存在させる
    await repos.faq.create({
      ticketId: ticket.id,
      createdById: AGENT_A,
      question: '候補のままの質問',
      answer: '候補のままの回答',
      tenantId: TENANT_A,
    });
    // 別テナントの公開済み FAQ も存在させる (クロステナント漏洩防止の確認)
    const agentB = 'agent-b';
    const ticketB = await seedTicketAndAgent(TENANT_B, 'テナントBの問い合わせ', agentB);
    const publishedB = await repos.faq.create({
      ticketId: ticketB.id,
      createdById: agentB,
      question: 'テナントBの公開質問',
      answer: 'テナントBの公開回答',
      tenantId: TENANT_B,
    });
    await repos.faq.updateStatus(publishedB.id, 'Published', TENANT_B);

    const result = await repos.faq.listPublished(TENANT_A);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: published.id,
      question: '公開済みの質問',
      answer: '公開済みの回答',
    });
  });

  // updateStatus: 状態を更新できる (Published/Rejected 等)
  it('updateStatusで状態を更新できる', async () => {
    const ticket = await seedTicketAndAgent(TENANT_A, 'チケット', AGENT_A);
    const faq = await repos.faq.create({
      ticketId: ticket.id,
      createdById: AGENT_A,
      question: 'Q',
      answer: 'A',
      tenantId: TENANT_A,
    });
    await repos.faq.updateStatus(faq.id, 'Published', TENANT_A);
    const reloaded = await repos.faq.findById(faq.id, TENANT_A);
    expect(reloaded?.status).toBe('Published');
  });

  // updateStatus: 他テナントの ID は no-op (更新されない)
  it('updateStatusは他テナントのIDに対してno-opになる', async () => {
    const ticket = await seedTicketAndAgent(TENANT_A, 'チケット', AGENT_A);
    const faq = await repos.faq.create({
      ticketId: ticket.id,
      createdById: AGENT_A,
      question: 'Q',
      answer: 'A',
      tenantId: TENANT_A,
    });
    await repos.faq.updateStatus(faq.id, 'Published', TENANT_B);
    const reloaded = await repos.faq.findById(faq.id, TENANT_A);
    expect(reloaded?.status).toBe('Candidate');
  });

  // updateContent: 質問/回答の本文を更新できる (フォローアップ 2026-07-14 #6)
  it('updateContentで質問/回答を更新できる', async () => {
    const ticket = await seedTicketAndAgent(TENANT_A, 'チケット', AGENT_A);
    const faq = await repos.faq.create({
      ticketId: ticket.id,
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

  // updateContent: 他テナントの ID は no-op (更新されない)
  it('updateContentは他テナントのIDに対してno-opになる', async () => {
    const ticket = await seedTicketAndAgent(TENANT_A, 'チケット', AGENT_A);
    const faq = await repos.faq.create({
      ticketId: ticket.id,
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
