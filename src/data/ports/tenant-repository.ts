// ドメイン層の Tenant 型を参照
import type { Tenant } from '@/domain/types';

// Tenant 操作の契約 (port)。本 PR では取得系のみで十分。create/update は後続 PR で追加
export interface TenantRepository {
  findById(id: string): Promise<Tenant | null>; // 主キー検索
  findDefault(): Promise<Tenant | null>; // ピボット途中で使う 'default-tenant' を取得する便利メソッド
}
