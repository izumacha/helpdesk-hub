// ドメイン層のユーザー型をインポート
import type { Role, User, UserSummary } from '@/domain/types';

// ユーザー取得系リポジトリの契約 (port)
// 認証フローで使う findById / findByEmail は **tenantId スコープなし** (どのテナントに
// 属するかを判定するためにこそユーザーを引くので、ここで scope を強制すると鶏卵問題になる)。
// 一方、UI から候補を引く系のメソッドは全て tenantId 必須でクロステナント漏洩を防ぐ。
export interface UserRepository {
  findById(id: string): Promise<User | null>; // ID 指定で 1 件取得 (認証用、テナント横断)
  findByEmail(email: string): Promise<User | null>; // メール指定で 1 件取得 (ログイン用、テナント横断)
  // 新規ユーザーを 1 件作成する (招待受諾・テナント作成時の初代管理者登録で使う)。
  // tenantId は招待行 / 作成テナント由来のみを渡す契約 (リクエスト入力から注入しないこと)。
  // email は @unique 制約のため、重複時はアダプタが例外を投げる (呼び出し側で握って案内する)。
  create(input: {
    email: string; // ログイン用メール (小文字正規化済みであること)
    name: string; // 表示名
    passwordHash: string; // bcrypt 済みパスワードハッシュ (平文は渡さない)
    role: Role; // 付与する権限
    tenantId: string; // 所属テナント ID
  }): Promise<User>;
  /** Agents and admins in the given tenant. */
  listAgents(tenantId: string): Promise<UserSummary[]>; // 当該テナント内の agent/admin 一覧
  listAgentIds(tenantId: string): Promise<string[]>; // 当該テナント内の agent/admin の ID だけ
  findSummariesByIds(ids: string[], tenantId: string): Promise<UserSummary[]>; // テナント内 ID 配列から概要
}
