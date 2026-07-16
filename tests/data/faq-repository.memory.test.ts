// FAQ リポジトリ (メモリアダプタ) の単体テスト。
// 監査で発見したギャップ: FaqRepository には Port/Prisma/メモリの各アダプタが揃っているのに
// テストが 1 つも無かった。findById/updateStatus のテナントスコープ (クロステナント漏洩防止)
// と、list() が関連チケット/作成者を正しく結合することを検証する。

import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryContext, type Store } from '@/data/adapters/memory';
import type { Repos } from '@/data/ports/unit-of-work';
import { FAQ_LIST_LIMIT } from '@/data/ports/faq-repository';

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

    const result = await repos.faq.list(TENANT_A, { limit: FAQ_LIST_LIMIT });
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
    const result = await repos.faq.list(TENANT_A, { limit: FAQ_LIST_LIMIT });
    expect(result.map((f) => f.id)).toEqual([second.id, first.id]);
  });

  // list/listPublished: limit で件数が上限化される
  // フォローアップ (2026-07-16 #3): 監査で発見したギャップ。§8「一覧取得は必ず上限を持たせる」に
  // 反し、以前は limit 引数自体が存在せず常に全件返していた
  it('listとlistPublishedはlimitで新しい順に件数を上限化する', async () => {
    const ticket = await seedTicketAndAgent(TENANT_A, 'チケット', AGENT_A);
    // Candidate 2 件 + Published 2 件を作成日時をずらして作る
    for (let i = 0; i < 2; i++) {
      await repos.faq.create({
        ticketId: ticket.id,
        createdById: AGENT_A,
        question: `候補${i}`,
        answer: `回答${i}`,
        tenantId: TENANT_A,
      });
      await new Promise((r) => setTimeout(r, 2));
    }
    for (let i = 0; i < 2; i++) {
      const faq = await repos.faq.create({
        ticketId: ticket.id,
        createdById: AGENT_A,
        question: `公開${i}`,
        answer: `回答${i}`,
        tenantId: TENANT_A,
      });
      await repos.faq.updateStatus(faq.id, { from: 'Candidate', to: 'Published' }, TENANT_A);
      await new Promise((r) => setTimeout(r, 2));
    }

    // 全 4 件のうち limit: 1 なら 1 件だけ (最新のもの) が返る
    const listResult = await repos.faq.list(TENANT_A, { limit: 1 });
    expect(listResult).toHaveLength(1);
    expect(listResult[0].question).toBe('公開1');

    // 公開済み 2 件のうち limit: 1 なら 1 件だけ (最新のもの) が返る
    const publishedResult = await repos.faq.listPublished(TENANT_A, { limit: 1 });
    expect(publishedResult).toHaveLength(1);
    expect(publishedResult[0].question).toBe('公開1');
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
    await repos.faq.updateStatus(published.id, { from: 'Candidate', to: 'Published' }, TENANT_A);
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
    await repos.faq.updateStatus(publishedB.id, { from: 'Candidate', to: 'Published' }, TENANT_B);

    const result = await repos.faq.listPublished(TENANT_A, { limit: FAQ_LIST_LIMIT });
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: published.id,
      question: '公開済みの質問',
      answer: '公開済みの回答',
    });
  });

  // updateStatus: 期待状態 (from) が一致していれば状態を更新でき、true を返す
  it('updateStatusで状態を更新できる', async () => {
    const ticket = await seedTicketAndAgent(TENANT_A, 'チケット', AGENT_A);
    const faq = await repos.faq.create({
      ticketId: ticket.id,
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

  // updateStatus: 他テナントの ID は no-op (更新されず false を返す)
  it('updateStatusは他テナントのIDに対してno-opになる', async () => {
    const ticket = await seedTicketAndAgent(TENANT_A, 'チケット', AGENT_A);
    const faq = await repos.faq.create({
      ticketId: ticket.id,
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

  // updateStatus: 期待状態 (from) が現在の状態と異なる場合は更新せず false を返す
  // (フォローアップ 2026-07-15: check-then-act 競合で禁止遷移が後勝ちするのを防ぐ)
  it('updateStatusは期待状態が一致しない場合に更新せずfalseを返す', async () => {
    const ticket = await seedTicketAndAgent(TENANT_A, 'チケット', AGENT_A);
    const faq = await repos.faq.create({
      ticketId: ticket.id,
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
    const updated = await repos.faq.updateContent(
      faq.id,
      { question: '新しい質問', answer: '新しい回答' },
      { question: '元の質問', answer: '元の回答' },
      TENANT_A,
    );
    expect(updated).toBe(true);
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
    const updated = await repos.faq.updateContent(
      faq.id,
      { question: '書き換え試行', answer: '書き換え試行' },
      { question: '元の質問', answer: '元の回答' },
      TENANT_B,
    );
    expect(updated).toBe(false);
    const reloaded = await repos.faq.findById(faq.id, TENANT_A);
    expect(reloaded?.question).toBe('元の質問');
    expect(reloaded?.answer).toBe('元の回答');
  });

  // updateContent: 期待する現在の質問/回答が一致しない場合は更新せず false を返す
  // (フォローアップ 2026-07-16 #5: updateStatus と同じ check-then-act 競合防止の回帰テスト)
  it('updateContentは期待する内容が一致しない場合に更新せずfalseを返す', async () => {
    const ticket = await seedTicketAndAgent(TENANT_A, 'チケット', AGENT_A);
    const faq = await repos.faq.create({
      ticketId: ticket.id,
      createdById: AGENT_A,
      question: '元の質問',
      answer: '元の回答',
      tenantId: TENANT_A,
    });
    // 先行する別の操作が既に内容を書き換えた想定
    await repos.faq.updateContent(
      faq.id,
      { question: '先行更新後の質問', answer: '先行更新後の回答' },
      { question: '元の質問', answer: '元の回答' },
      TENANT_A,
    );
    // 古い読み取り (元の質問/回答) を前提にした更新は失敗し、先行更新の内容のまま変わらない
    const updated = await repos.faq.updateContent(
      faq.id,
      { question: '競合した更新', answer: '競合した更新' },
      { question: '元の質問', answer: '元の回答' },
      TENANT_A,
    );
    expect(updated).toBe(false);
    const reloaded = await repos.faq.findById(faq.id, TENANT_A);
    expect(reloaded?.question).toBe('先行更新後の質問');
    expect(reloaded?.answer).toBe('先行更新後の回答');
  });
});
