import type { UserRepository } from '@/data/ports/user-repository';
import type { UserSummary } from '@/domain/types';
import type { Store } from './store';

export function makeUserRepo(store: Store): UserRepository {
  return {
    async findById(id) {
      const u = store.users.get(id);
      return u ? { ...u } : null;
    },

    async findByEmail(email) {
      for (const u of store.users.values()) {
        if (u.email === email) return { ...u };
      }
      return null;
    },

    async listAgents() {
      const agents: UserSummary[] = [];
      for (const u of store.users.values()) {
        if (u.role === 'agent' || u.role === 'admin') {
          agents.push({ id: u.id, name: u.name });
        }
      }
      agents.sort((a, b) => a.name.localeCompare(b.name));
      return agents;
    },

    async listAgentIds() {
      const ids: string[] = [];
      for (const u of store.users.values()) {
        if (u.role === 'agent' || u.role === 'admin') ids.push(u.id);
      }
      return ids;
    },

    async findSummariesByIds(ids) {
      const set = new Set(ids);
      const out: UserSummary[] = [];
      for (const u of store.users.values()) {
        if (set.has(u.id)) out.push({ id: u.id, name: u.name });
      }
      return out;
    },
  };
}
