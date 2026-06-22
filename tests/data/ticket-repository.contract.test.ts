// Vitest の describe (テストグループ) のみ使う
import { describe } from 'vitest';
// メモリ実装のリポジトリ束を作成するファクトリ
import { createMemoryContext } from '@/data/adapters/memory';
// ユーザー型 (シードフィクスチャ用)
import type { User } from '@/domain/types';
// 共通契約テストとそのコンテキスト型
import { runTicketRepositoryContract, type ContractContext } from './ticket-repository.contract';

// 主に使うテナント ID (マルチテナント化後はあらゆる行で必須)
const TENANT_ID = 'default-tenant';
// クロステナント回帰テスト用のもう 1 つのテナント ID
const SECOND_TENANT_ID = 'tenant-b';

// メモリ実装向けに ContractContext を組み立てる
function makeMemoryContext(): ContractContext {
  // 純粋メモリ実装の store / repos / uow を生成
  const { store, repos, uow } = createMemoryContext();

  // 各テストで呼ばれる「最小限のシード」: 1 テナント + 1 依頼者 + 2 エージェント + 1 カテゴリ
  const seedBasicFixture: ContractContext['seedBasicFixture'] = async () => {
    const now = new Date();
    // まずデフォルトテナントを投入 (User/Category/Ticket の FK 先として必要)
    store.tenants.set(TENANT_ID, {
      id: TENANT_ID,
      name: 'デフォルト組織',
      mode: 'lite',
      industry: null,
      inboundToken: null, // メール取り込み未発行 (テスト用フィクスチャ)
      slackWebhookUrl: null, subscriptionPlan: 'free' as const, stripeCustomerId: null, stripeSubscriptionId: null, stripeSubscriptionStatus: null, teamsWebhookUrl: null, chatworkApiToken: null, chatworkRoomId: null, // Slack 通知未設定 (テスト用フィクスチャ)
      createdAt: now,
    });
    // 投入するユーザーのテーブル (id, role, name)
    const users: Array<[string, User['role'], string]> = [
      ['u-req-1', 'requester', '山田 太郎'],
      ['u-agt-1', 'agent', '佐藤 一郎'],
      ['u-agt-2', 'agent', '鈴木 二郎'],
    ];
    // store に直接書き込む (リポジトリは User の create を持たないため)
    for (const [id, role, name] of users) {
      store.users.set(id, {
        id,
        email: `${id}@example.com`,
        name,
        passwordHash: 'x',
        role,
        tenantId: TENANT_ID, // テナントスコープを必ず付与
        createdAt: now,
        updatedAt: now,
      });
    }
    // 1 つだけカテゴリを投入 (テナント所属)
    store.categories.set('cat-1', {
      id: 'cat-1',
      name: 'アカウント',
      createdAt: now,
      tenantId: TENANT_ID,
    });
    // テスト本体が使う ID とユーザー実体を返す
    return {
      requester: store.users.get('u-req-1')!,
      agentA: store.users.get('u-agt-1')!,
      agentB: store.users.get('u-agt-2')!,
      categoryId: 'cat-1',
    };
  };

  // クロステナント回帰テスト用に、もう 1 つのテナントを丸ごと用意する
  const seedSecondTenant: ContractContext['seedSecondTenant'] = async () => {
    const now = new Date();
    // テナント B を投入 (mode は lite で十分)
    store.tenants.set(SECOND_TENANT_ID, {
      id: SECOND_TENANT_ID,
      name: '別組織',
      mode: 'lite',
      industry: null,
      inboundToken: null, // メール取り込み未発行 (テスト用フィクスチャ)
      slackWebhookUrl: null, subscriptionPlan: 'free' as const, stripeCustomerId: null, stripeSubscriptionId: null, stripeSubscriptionStatus: null, teamsWebhookUrl: null, chatworkApiToken: null, chatworkRoomId: null, // Slack 通知未設定 (テスト用フィクスチャ)
      createdAt: now,
    });
    // テナント B 専属の依頼者ユーザーを 1 名作る
    const requesterId = 'u-b-req-1';
    store.users.set(requesterId, {
      id: requesterId,
      email: `${requesterId}@example.com`,
      name: '田中 一郎',
      passwordHash: 'x',
      role: 'requester',
      tenantId: SECOND_TENANT_ID, // 必ずテナント B のスコープに紐づけ
      createdAt: now,
      updatedAt: now,
    });
    // テナント B 専属のカテゴリも 1 件作る
    const categoryId = 'cat-b-1';
    store.categories.set(categoryId, {
      id: categoryId,
      name: '別組織カテゴリ',
      createdAt: now,
      tenantId: SECOND_TENANT_ID,
    });
    // クロステナント検証用の最小セット (テナント ID / 依頼者 / カテゴリ ID) を返す
    return {
      tenantId: SECOND_TENANT_ID,
      requester: store.users.get(requesterId)!,
      categoryId,
    };
  };

  return { repos, uow, seedBasicFixture, seedSecondTenant };
}

// メモリアダプタが TicketRepository 契約を満たしているかを実行
describe('memory adapter', () => {
  runTicketRepositoryContract(makeMemoryContext);
});
