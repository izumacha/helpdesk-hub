// POST /api/tickets の「期限日」(dueDate) パラメータが Pro モードのテナントでも
// 素通しで resolutionDueAt に反映されてしまう不備の回帰テスト。
// フォローアップ (2026-07-15 #3): 「期限日」は Lite モード専用の依頼者手動入力欄
// (TicketForm.tsx が Pro で欄自体を非表示にしている) であり、Pro モードは常にカテゴリ/優先度
// から自動算出される SLA のみを使う設計。しかしこの API を直接叩けば Web フォームの非表示を
// bypass でき、Pro テナントでも手動の resolutionDueAt を持つチケットを作成できてしまっていた。
// この手動値は後から updateTicketPriority の優先度変更で無警告に上書きされてしまうため、
// サーバー側でも Pro モードでは dueDate 指定を無視して常に自動算出する必要がある。

// Vitest の DSL とモック機能
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// メモリ実装の context (store/repos/uow)
import { createMemoryContext, type Store } from '@/data/adapters/memory';
// 型のみ
import type { Repos, UnitOfWork } from '@/data/ports/unit-of-work';
// 優先度ベースの解決期限自動算出 (期待値の算出に使う純粋関数)
import { calculateResolutionDueAt } from '@/lib/sla';

// 主に使うテナント ID と依頼者 ID
const TENANT = 'default-tenant';
const REQUESTER = 'u-req-1';

// 各テストで差し替える可変な依存 (Action import 前に値を入れる)
let store: Store;
let repos: Repos;
let uow: UnitOfWork;

// @/data モジュールを差し替え (getter で参照することで beforeEach の上書きを反映)
vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
  get uow() {
    return uow;
  },
}));

// セッションは依頼者で固定
vi.mock('@/lib/auth', () => ({
  auth: async () => ({
    user: { id: REQUESTER, role: 'requester' as const, tenantId: TENANT },
  }),
}));

// テナントを 1 件投入するヘルパー (mode を切り替えられるようにする)
async function seedTenant(mode: 'lite' | 'pro') {
  const now = new Date();
  store.tenants.set(TENANT, {
    id: TENANT,
    name: 'デフォルト組織',
    mode,
    industry: null,
    inboundToken: null,
    slackWebhookUrl: null,
    subscriptionPlan: 'free' as const,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripeSubscriptionStatus: null,
    trialEndsAt: null,
    teamsWebhookUrl: null,
    chatworkApiToken: null,
    chatworkRoomId: null,
    createdAt: now,
  });
  // 依頼者ユーザーを投入
  store.users.set(REQUESTER, {
    id: REQUESTER,
    email: 'requester@example.com',
    name: '山田 太郎',
    passwordHash: 'x',
    role: 'requester',
    tenantId: TENANT,
    createdAt: now,
    updatedAt: now,
  });
}

// JSON ボディでチケット作成リクエストを組み立てる
function buildJsonRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/tickets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  // 毎回新しい context を作って独立な状態にする
  const ctx = createMemoryContext();
  store = ctx.store;
  repos = ctx.repos;
  uow = ctx.uow;
  // 動的 import の結果をリセット (mock 設定を反映させるため)
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/tickets の dueDate (期限日) と mode の関係', () => {
  it('Lite テナントでは dueDate 指定が resolutionDueAt にそのまま反映される', async () => {
    await seedTenant('lite');
    const { POST } = await import('@/app/api/tickets/route');

    const res = await POST(
      buildJsonRequest({
        title: '複合機が印刷できない',
        body: '朝から紙詰まりが続く',
        priority: 'Medium',
        dueDate: '2026-09-01',
      }),
    );

    expect(res.status).toBe(201);
    const created = (await res.json()) as { resolutionDueAt: string };
    // 指定した期限日 (JST 終端) が反映されている
    expect(new Date(created.resolutionDueAt).getFullYear()).toBe(2026);
    expect(new Date(created.resolutionDueAt).getMonth()).toBe(8); // 0 始まりで 9 月
    expect(new Date(created.resolutionDueAt).getDate()).toBe(1);
  });

  it('Pro テナントでは dueDate 指定があっても無視され優先度ベースの自動算出値になる', async () => {
    await seedTenant('pro');
    const { POST } = await import('@/app/api/tickets/route');

    const res = await POST(
      buildJsonRequest({
        title: 'PC が起動しない',
        body: '電源ボタンを押しても反応なし',
        priority: 'Low',
        // Web フォームは Pro で dueDate 欄自体を非表示にするが、API を直接叩けば送れてしまう
        dueDate: '2026-09-01',
      }),
    );

    expect(res.status).toBe(201);
    const created = (await res.json()) as { resolutionDueAt: string; createdAt: string };
    const expected = calculateResolutionDueAt('Low', new Date(created.createdAt));
    // 指定した dueDate (2026-09-01) ではなく、優先度 (Low) ベースの自動算出値になっている
    // (route.ts 内部の now とテスト側で created.createdAt から再計算した基準時刻は数 ms
    // ずれ得るため、厳密な一致ではなく許容誤差付きで比較する)
    expect(Math.abs(new Date(created.resolutionDueAt).getTime() - expected.getTime())).toBeLessThan(
      1000,
    );
    // 指定した dueDate (2026-09-01 の JST 終端) とは異なる値になっている
    expect(new Date(created.resolutionDueAt).getMonth()).not.toBe(8); // 0 始まりで 9 月ではない
  });
});
