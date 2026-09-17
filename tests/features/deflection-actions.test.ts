// AI FAQ 自己解決 (§4.29) の Server Action (suggestFaqForDraft / recordDeflectionOutcome) のテスト。
// 認証・プランゲート・レート制限・前段抽出 → LLM 照合 → 検証 → 計測記録の一連の流れを、
// メモリアダプタと LLM モックで完結させる (§11 外部 API はモックして実際には呼ばない)

// Vitest のテスト DSL とモック機能
import { beforeEach, describe, expect, it, vi } from 'vitest';
// メモリ実装の context (store/repos を持つ)
import { createMemoryContext, type Store } from '@/data/adapters/memory';
// リポジトリ束の型
import type { Repos } from '@/data/ports/unit-of-work';
// レート制限の履歴をテスト間でクリアする内部用関数
import { __resetRateLimits } from '@/lib/rate-limit';
// LLM 照合クライアントの契約型 (モックの形を合わせる)
import type { DeflectionMatcher, MatcherResult } from '@/lib/deflection-llm';
// 課金プラン型
import type { SubscriptionPlan } from '@/domain/types';

// 各テスト前に書き換える "可変" な依存
let store: Store;
let repos: Repos;
// テナントスコープと依頼者 (テストは単一テナント前提で固定)
const TENANT = 'default-tenant';
const OTHER_TENANT = 'other-tenant';
const USER_ID = 'u-req-1';
// セッションのユーザー ID (他人の記録を更新できないことの検証で差し替える)
let sessionUserId = USER_ID;
// LLM モックが返す結果 (テストごとに差し替える)
let matcherResult: MatcherResult = { ok: true, verdicts: [] };
// LLM モックが受け取った入力 (候補件数の検証用)
let matcherCalls: Array<{ query: string; candidateIds: string[] }> = [];
// LLM が構成済みか (false なら getDeflectionMatcher が null を返す = 機能無効)
let matcherConfigured = true;

// @/data モジュールを差し替え。getter で参照することで、テスト中の上書きを反映
vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
}));

// 認証は固定セッションを返すモックに置換 (依頼者ロール)
vi.mock('@/lib/auth', () => ({
  auth: async () => ({
    user: { id: sessionUserId, role: 'requester', tenantId: TENANT },
  }),
}));

// LLM 照合クライアントをモックに置換 (実 API は呼ばない)
vi.mock('@/lib/deflection-llm', () => ({
  getDeflectionMatcher: (): DeflectionMatcher | null =>
    matcherConfigured
      ? {
          model: 'mock-model',
          async match({ query, candidates }) {
            // 受け取った入力を記録して、テストが指定した結果を返す
            matcherCalls.push({ query, candidateIds: candidates.map((c) => c.id) });
            return matcherResult;
          },
        }
      : null,
}));

// テナント・依頼者・公開 FAQ をシードする共通ヘルパー
function seed(plan: SubscriptionPlan = 'pro') {
  const now = new Date();
  // テナント (プランは引数で切り替える)
  for (const id of [TENANT, OTHER_TENANT]) {
    store.tenants.set(id, {
      id,
      name: id,
      mode: 'pro',
      industry: null,
      inboundToken: null,
      slackWebhookUrl: null,
      teamsWebhookUrl: null,
      chatworkApiToken: null,
      chatworkRoomId: null,
      subscriptionPlan: plan,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      stripeSubscriptionStatus: null,
      trialEndsAt: null,
      createdAt: now,
    });
  }
  // 依頼者
  store.users.set(USER_ID, {
    id: USER_ID,
    email: 'req@example.com',
    name: '依頼者',
    passwordHash: 'x',
    role: 'requester',
    tenantId: TENANT,
    createdAt: now,
    updatedAt: now,
  });
  // 公開済み FAQ (VPN) と候補のまま (未公開) の FAQ (プリンター)、他テナントの公開 FAQ
  store.faq.set('faq-vpn', {
    id: 'faq-vpn',
    ticketId: 't-1',
    createdById: USER_ID,
    question: 'VPN に接続できません',
    answer: 'VPN クライアントを再起動し、社内アカウントで再ログインしてください。',
    status: 'Published',
    createdAt: now,
    updatedAt: now,
    tenantId: TENANT,
  });
  store.faq.set('faq-printer-candidate', {
    id: 'faq-printer-candidate',
    ticketId: 't-2',
    createdById: USER_ID,
    question: 'VPN 経由でプリンターに印刷できない',
    answer: 'VPN 接続中は社内プリンターの IP を直接指定してください。',
    status: 'Candidate', // 未公開 (提案対象外)
    createdAt: now,
    updatedAt: now,
    tenantId: TENANT,
  });
  store.faq.set('faq-other-tenant', {
    id: 'faq-other-tenant',
    ticketId: 't-3',
    createdById: USER_ID,
    question: 'VPN に接続できません (他社)',
    answer: '他テナントの回答',
    status: 'Published',
    createdAt: now,
    updatedAt: now,
    tenantId: OTHER_TENANT, // 他テナント (提案対象外)
  });
}

// VPN 関連の下書き (公開 FAQ と字面が近い)
const VPN_DRAFT = {
  title: 'VPN につながらない',
  body: '在宅勤務中に VPN 接続ができなくなりました。',
};

beforeEach(() => {
  const ctx = createMemoryContext();
  store = ctx.store;
  repos = ctx.repos;
  __resetRateLimits();
  vi.resetModules();
  sessionUserId = USER_ID;
  matcherResult = { ok: true, verdicts: [] };
  matcherCalls = [];
  matcherConfigured = true;
  seed();
});

describe('suggestFaqForDraft', () => {
  // 正常系: 公開 FAQ が一致し、suggested として記録される
  it('公開済み FAQ が一致すれば提示し、suggested として記録する', async () => {
    // LLM は VPN FAQ を高確信度で返す
    matcherResult = { ok: true, verdicts: [{ faqId: 'faq-vpn', confidence: 0.9 }] };
    const { suggestFaqForDraft } = await import('@/features/deflection/actions/deflection-actions');
    const result = await suggestFaqForDraft(VPN_DRAFT);
    // 提示あり
    expect(result.status).toBe('suggested');
    if (result.status !== 'suggested') throw new Error('unreachable');
    // 提示内容は FAQ の本文をそのまま引用している
    expect(result.matches).toEqual([
      {
        faqId: 'faq-vpn',
        question: 'VPN に接続できません',
        answer: 'VPN クライアントを再起動し、社内アカウントで再ログインしてください。',
        confidence: 0.9,
      },
    ]);
    // 計測記録が suggested / 候補 1 件 / モデル名付きで残る (本文は保存しない)
    const event = store.deflectionEvents.get(result.eventId);
    expect(event).toMatchObject({
      outcome: 'suggested',
      candidateCount: 1,
      matchedFaqId: 'faq-vpn',
      model: 'mock-model',
      userId: USER_ID,
      tenantId: TENANT,
    });
    expect(JSON.stringify(event)).not.toContain('在宅勤務');
  });

  // 前段抽出: 未公開 FAQ と他テナントの FAQ は LLM に渡さない
  it('未公開 FAQ と他テナントの FAQ は候補に含めない', async () => {
    matcherResult = { ok: true, verdicts: [] };
    const { suggestFaqForDraft } = await import('@/features/deflection/actions/deflection-actions');
    await suggestFaqForDraft(VPN_DRAFT);
    // LLM に渡った候補は公開済み・自テナントの 1 件だけ
    expect(matcherCalls).toHaveLength(1);
    expect(matcherCalls[0]?.candidateIds).toEqual(['faq-vpn']);
  });

  // 引用の真正性: LLM が候補外 ID を返しても提示しない
  it('LLM が候補外の FAQ ID を返しても幻覚として捨て、no_match として記録する', async () => {
    // 未公開 FAQ の ID と存在しない ID を返す (どちらも候補外)
    matcherResult = {
      ok: true,
      verdicts: [
        { faqId: 'faq-printer-candidate', confidence: 0.99 },
        { faqId: 'faq-made-up', confidence: 0.99 },
      ],
    };
    const { suggestFaqForDraft } = await import('@/features/deflection/actions/deflection-actions');
    const result = await suggestFaqForDraft(VPN_DRAFT);
    // 該当なし
    expect(result.status).toBe('none');
    if (result.status !== 'none') throw new Error('unreachable');
    // no_match として記録 (候補は 1 件渡していた)
    expect(store.deflectionEvents.get(result.eventId)).toMatchObject({
      outcome: 'no_match',
      candidateCount: 1,
      matchedFaqId: null,
      model: 'mock-model',
    });
  });

  // 前段抽出で候補ゼロなら LLM を呼ばない (コスト削減) が、no_match は記録する
  it('字面が重ならない下書きでは LLM を呼ばずに no_match を記録する', async () => {
    const { suggestFaqForDraft } = await import('@/features/deflection/actions/deflection-actions');
    const result = await suggestFaqForDraft({ title: 'hello', body: 'unrelated english text' });
    expect(result.status).toBe('none');
    if (result.status !== 'none') throw new Error('unreachable');
    // LLM 未呼び出し
    expect(matcherCalls).toHaveLength(0);
    // 候補 0 件・モデル null で記録
    expect(store.deflectionEvents.get(result.eventId)).toMatchObject({
      outcome: 'no_match',
      candidateCount: 0,
      model: null,
    });
  });

  // プランゲート: Pro 未満は提示しない (Standard / Free / トライアル中の Free)
  it('Pro 未満のプランでは unavailable を返し、LLM も呼ばず記録も残さない', async () => {
    for (const plan of ['free', 'standard'] as const) {
      // プランを差し替える
      seed(plan);
      vi.resetModules();
      const { suggestFaqForDraft } =
        await import('@/features/deflection/actions/deflection-actions');
      const result = await suggestFaqForDraft(VPN_DRAFT);
      expect(result.status).toBe('unavailable');
    }
    // トライアル中 (Standard 相当) でも昇格しない
    seed('free');
    const t = store.tenants.get(TENANT);
    if (!t) throw new Error('seed missing');
    store.tenants.set(TENANT, { ...t, trialEndsAt: new Date(Date.now() + 86_400_000) });
    vi.resetModules();
    const { suggestFaqForDraft } = await import('@/features/deflection/actions/deflection-actions');
    expect((await suggestFaqForDraft(VPN_DRAFT)).status).toBe('unavailable');
    // いずれも LLM 未呼び出し・記録なし
    expect(matcherCalls).toHaveLength(0);
    expect(store.deflectionEvents.size).toBe(0);
  });

  // 未構成 (API キー無し) なら unavailable
  it('LLM が未構成なら unavailable を返す', async () => {
    matcherConfigured = false;
    const { suggestFaqForDraft } = await import('@/features/deflection/actions/deflection-actions');
    expect((await suggestFaqForDraft(VPN_DRAFT)).status).toBe('unavailable');
    expect(store.deflectionEvents.size).toBe(0);
  });

  // LLM 呼び出し失敗は unavailable (起票を妨げない) で、記録も残さない
  it('LLM 呼び出しが失敗したら unavailable を返す', async () => {
    matcherResult = { ok: false, reason: 'http 500' };
    // 失敗ログは出るが握り潰さない (console.warn を確認する)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { suggestFaqForDraft } = await import('@/features/deflection/actions/deflection-actions');
    expect((await suggestFaqForDraft(VPN_DRAFT)).status).toBe('unavailable');
    expect(warn).toHaveBeenCalled();
    expect(store.deflectionEvents.size).toBe(0);
    warn.mockRestore();
  });

  // 入力検証: 件名/内容が規則外なら提示しない
  it('件名や内容が空なら unavailable を返す', async () => {
    const { suggestFaqForDraft } = await import('@/features/deflection/actions/deflection-actions');
    expect((await suggestFaqForDraft({ title: '', body: 'x' })).status).toBe('unavailable');
    expect((await suggestFaqForDraft({ title: 'x', body: '   ' })).status).toBe('unavailable');
    expect(matcherCalls).toHaveLength(0);
  });

  // レート制限: 上限を超えると unavailable に縮退する
  it('ユーザー単位のレート制限を超えると unavailable を返す', async () => {
    matcherResult = { ok: true, verdicts: [] };
    const { suggestFaqForDraft } = await import('@/features/deflection/actions/deflection-actions');
    // 上限 (10 回/分) まで呼ぶ
    for (let i = 0; i < 10; i += 1) {
      expect((await suggestFaqForDraft(VPN_DRAFT)).status).toBe('none');
    }
    // 11 回目は縮退
    expect((await suggestFaqForDraft(VPN_DRAFT)).status).toBe('unavailable');
  });
});

describe('recordDeflectionOutcome', () => {
  // suggested の記録を作る共通ヘルパー
  async function seedSuggested(userId: string = USER_ID): Promise<string> {
    const event = await repos.deflectionEvents.create({
      tenantId: TENANT,
      userId,
      outcome: 'suggested',
      candidateCount: 1,
      matchedFaqId: 'faq-vpn',
      model: 'mock-model',
    });
    return event.id;
  }

  // 「解決した」を resolved として記録する
  it('suggested → resolved を記録する', async () => {
    const eventId = await seedSuggested();
    const { recordDeflectionOutcome } =
      await import('@/features/deflection/actions/deflection-actions');
    expect(await recordDeflectionOutcome({ eventId, outcome: 'resolved' })).toEqual({ ok: true });
    expect(store.deflectionEvents.get(eventId)).toMatchObject({
      outcome: 'resolved',
      ticketId: null,
    });
  });

  // 起票に進んだ場合は自テナントに実在するチケット ID だけを紐づける
  it('proceeded は自テナントに実在するチケット ID だけを紐づける', async () => {
    const eventId = await seedSuggested();
    // 自テナントのチケットを 1 件作る
    const ticket = await repos.tickets.create({
      title: 'VPN につながらない',
      body: '本文',
      priority: 'Medium',
      categoryId: null,
      creatorId: USER_ID,
      tenantId: TENANT,
      status: 'Open',
    });
    const { recordDeflectionOutcome } =
      await import('@/features/deflection/actions/deflection-actions');
    expect(
      await recordDeflectionOutcome({ eventId, outcome: 'proceeded', ticketId: ticket.id }),
    ).toEqual({ ok: true });
    expect(store.deflectionEvents.get(eventId)).toMatchObject({
      outcome: 'proceeded',
      ticketId: ticket.id,
    });

    // 存在しないチケット ID を渡した場合は紐づけずに決着だけ記録する
    const eventId2 = await seedSuggested();
    expect(
      await recordDeflectionOutcome({ eventId: eventId2, outcome: 'proceeded', ticketId: 'nope' }),
    ).toEqual({ ok: true });
    expect(store.deflectionEvents.get(eventId2)).toMatchObject({
      outcome: 'proceeded',
      ticketId: null,
    });
  });

  // CAS: 一度決着した記録は上書きできない (二重送信・後勝ち防止)
  it('一度決着した記録は再度更新できない', async () => {
    const eventId = await seedSuggested();
    const { recordDeflectionOutcome } =
      await import('@/features/deflection/actions/deflection-actions');
    expect(await recordDeflectionOutcome({ eventId, outcome: 'resolved' })).toEqual({ ok: true });
    // 2 回目 (proceeded への上書き) は失敗する
    expect(await recordDeflectionOutcome({ eventId, outcome: 'proceeded' })).toEqual({ ok: false });
    expect(store.deflectionEvents.get(eventId)?.outcome).toBe('resolved');
  });

  // 本人以外の記録は更新できない
  it('他人の記録は更新できない', async () => {
    // 別ユーザーの記録
    const eventId = await seedSuggested('u-someone-else');
    const { recordDeflectionOutcome } =
      await import('@/features/deflection/actions/deflection-actions');
    expect(await recordDeflectionOutcome({ eventId, outcome: 'resolved' })).toEqual({ ok: false });
    expect(store.deflectionEvents.get(eventId)?.outcome).toBe('suggested');
  });

  // 入力検証: 不正な outcome / 空の eventId は記録しない
  it('不正な入力は記録しない', async () => {
    const { recordDeflectionOutcome } =
      await import('@/features/deflection/actions/deflection-actions');
    expect(await recordDeflectionOutcome({ eventId: '', outcome: 'resolved' })).toEqual({
      ok: false,
    });
    expect(
      await recordDeflectionOutcome({
        eventId: 'x',
        outcome: 'suggested' as unknown as 'resolved',
      }),
    ).toEqual({ ok: false });
  });
});
