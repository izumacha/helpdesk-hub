// ドメイン層のユーザー型をインポート
import type { User, UserSummary } from '@/domain/types';

// ユーザー取得系リポジトリの契約 (port)
// 認証フローで使う findById / findByEmail は **tenantId スコープなし** (どのテナントに
// 属するかを判定するためにこそユーザーを引くので、ここで scope を強制すると鶏卵問題になる)。
// 一方、UI から候補を引く系のメソッドは全て tenantId 必須でクロステナント漏洩を防ぐ。
export interface UserRepository {
  findById(id: string): Promise<User | null>; // ID 指定で 1 件取得 (認証用、テナント横断)
  findByEmail(email: string): Promise<User | null>; // メール指定で 1 件取得 (ログイン用、テナント横断)
  /** Agents and admins in the given tenant. */
  listAgents(tenantId: string): Promise<UserSummary[]>; // 当該テナント内の agent/admin 一覧
  listAgentIds(tenantId: string): Promise<string[]>; // 当該テナント内の agent/admin の ID だけ
  findSummariesByIds(ids: string[], tenantId: string): Promise<UserSummary[]>; // テナント内 ID 配列から概要
}
