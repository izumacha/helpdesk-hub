// Tenant リポジトリの契約 (port)
import type { TenantRepository } from '@/data/ports/tenant-repository';
// メモリストア型
import type { Store } from './store';

// メモリストアを使った Tenant リポジトリを生成する関数 (テスト用)
export function makeTenantRepo(store: Store): TenantRepository {
  return {
    // ID で 1 件取得 (見つからなければ null)
    async findById(id) {
      const t = store.tenants.get(id); // Map から取得
      return t ? { ...t } : null; // 防御的コピーを返す
    },

    // 'default-tenant' を取得
    async findDefault() {
      const t = store.tenants.get('default-tenant');
      return t ? { ...t } : null;
    },
  };
}
