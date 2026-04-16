import { describe } from 'vitest';
import { createMemoryContext } from '@/data/adapters/memory';
import type { User } from '@/domain/types';
import { runTicketRepositoryContract, type ContractContext } from './ticket-repository.contract';

function makeMemoryContext(): ContractContext {
  const { store, repos, uow } = createMemoryContext();

  const seedBasicFixture: ContractContext['seedBasicFixture'] = async () => {
    const now = new Date();
    const users: Array<[string, User['role'], string]> = [
      ['u-req-1', 'requester', '山田 太郎'],
      ['u-agt-1', 'agent', '佐藤 一郎'],
      ['u-agt-2', 'agent', '鈴木 二郎'],
    ];
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
    store.categories.set('cat-1', { id: 'cat-1', name: 'アカウント', createdAt: now });
    return {
      requester: store.users.get('u-req-1')!,
      agentA: store.users.get('u-agt-1')!,
      agentB: store.users.get('u-agt-2')!,
      categoryId: 'cat-1',
    };
  };

  return { repos, uow, seedBasicFixture };
}

describe('memory adapter', () => {
  runTicketRepositoryContract(makeMemoryContext);
});
