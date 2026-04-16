import type { User, UserSummary } from '@/domain/types';

export interface UserRepository {
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  /** Agents and admins. */
  listAgents(): Promise<UserSummary[]>;
  listAgentIds(): Promise<string[]>;
  findSummariesByIds(ids: string[]): Promise<UserSummary[]>;
}
