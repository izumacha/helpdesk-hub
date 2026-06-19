// Tenant リポジトリの契約 (port)
import type { TenantRepository } from '@/data/ports/tenant-repository';
// ドメイン型
import type { Tenant } from '@/domain/types';
// メモリストア型と ID 生成関数
import { nextId, type Store } from './store';

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

    // 新規テナント (組織) を 1 件作成する (テナント作成フォーム用)
    async create(input) {
      // 新しいテナント行を組み立てる (mode 未指定なら lite)
      const tenant: Tenant = {
        id: nextId(store, 'tnt'), // 'tnt_...' 形式の一意 ID
        name: input.name,
        mode: input.mode ?? 'lite',
        industry: input.industry ?? null,
        createdAt: new Date(),
      };
      // ストアの Map に登録
      store.tenants.set(tenant.id, tenant);
      // 防御的コピーを返す
      return { ...tenant };
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
