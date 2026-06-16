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

    // テナントの動作モード (lite | pro) を更新し、更新後の Tenant を返す
    async updateMode(id, mode) {
      // 対象テナントを Map から取得 (存在しなければ Prisma の update と同様にエラー)
      const t = store.tenants.get(id);
      if (!t) throw new Error('テナントが見つかりません');
      // mode だけ差し替えた新しいオブジェクトを作り Map に書き戻す
      const updated = { ...t, mode };
      store.tenants.set(id, updated);
      // 防御的コピーを返す (呼び出し側で破壊されないように)
      return { ...updated };
    },
  };
}
