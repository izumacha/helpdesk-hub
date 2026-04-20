// Vitest の describe (テストグループ) のみ使う
import { describe } from 'vitest';
// メモリ実装のリポジトリ束を作成するファクトリ
import { createMemoryContext } from '@/data/adapters/memory';
// ユーザー型 (シードフィクスチャ用)
import type { User } from '@/domain/types';
// 共通契約テストとそのコンテキスト型
import { runTicketRepositoryContract, type ContractContext } from './ticket-repository.contract';

// メモリ実装向けに ContractContext を組み立てる
function makeMemoryContext(): ContractContext {
  // 純粋メモリ実装の store / repos / uow を生成
  const { store, repos, uow } = createMemoryContext();

  // 各テストで呼ばれる「最小限のシード」: 1 依頼者 + 2 エージェント + 1 カテゴリ
  const seedBasicFixture: ContractContext['seedBasicFixture'] = async () => {
    const now = new Date();
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
        createdAt: now,
        updatedAt: now,
      });
    }
    // 1 つだけカテゴリを投入
    store.categories.set('cat-1', { id: 'cat-1', name: 'アカウント', createdAt: now });
    // テスト本体が使う ID とユーザー実体を返す
    return {
      requester: store.users.get('u-req-1')!,
      agentA: store.users.get('u-agt-1')!,
      agentB: store.users.get('u-agt-2')!,
      categoryId: 'cat-1',
    };
  };

  return { repos, uow, seedBasicFixture };
}

// メモリアダプタが TicketRepository 契約を満たしているかを実行
describe('memory adapter', () => {
  runTicketRepositoryContract(makeMemoryContext);
});
