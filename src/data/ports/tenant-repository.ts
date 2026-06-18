// ドメイン層の Tenant 型とテナントモード型 (lite | pro) を参照
import type { Tenant, TenantMode } from '@/domain/types';

// Tenant 操作の契約 (port)。取得系に加え、Lite/Pro モード切替の更新系を提供する
export interface TenantRepository {
  findById(id: string): Promise<Tenant | null>; // 主キー検索
  findDefault(): Promise<Tenant | null>; // ピボット途中で使う 'default-tenant' を取得する便利メソッド
  // テナントの動作モード (lite | pro) を更新し、更新後の Tenant を返す
  // id はセッション由来の tenantId のみを渡す契約 (リクエスト入力から注入しないこと = クロステナント防止)
  updateMode(id: string, mode: TenantMode): Promise<Tenant>;
}
