// ドメイン層のユーザー型をインポート
import type { User, UserSummary } from '@/domain/types';

// ユーザー取得系リポジトリの契約 (port)
export interface UserRepository {
  findById(id: string): Promise<User | null>; // ID 指定で 1 件取得
  findByEmail(email: string): Promise<User | null>; // メール指定で 1 件取得 (ログインで利用)
  /** Agents and admins. */
  listAgents(): Promise<UserSummary[]>; // agent と admin の一覧 (アサイン候補)
  listAgentIds(): Promise<string[]>; // agent と admin の ID だけの一覧 (通知用)
  findSummariesByIds(ids: string[]): Promise<UserSummary[]>; // ID 配列から概要をまとめて取得
}
