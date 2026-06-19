// Tenant リポジトリの契約 (port)
import type { TenantRepository } from '@/data/ports/tenant-repository';
// ドメイン型
import type { Tenant } from '@/domain/types';
// Prisma の Tenant 行型
import type { Prisma } from '@/generated/prisma';
// Prisma クライアント/トランザクション共通型
import type { PrismaLike } from './types';

// Prisma の Tenant 行 (include なし)
type TenantRow = Prisma.TenantGetPayload<Record<string, never>>;

// Prisma 行 → ドメイン型 Tenant に変換
function toTenant(row: TenantRow): Tenant {
  // 必要なフィールドだけを詰め替えて返す (余計なフィールドは付与しない)
  return {
    id: row.id,
    name: row.name,
    mode: row.mode,
    industry: row.industry,
    createdAt: row.createdAt,
  };
}

// Prisma クライアントを使った Tenant リポジトリを生成する関数
export function makeTenantRepo(db: PrismaLike): TenantRepository {
  return {
    // ID で 1 件取得 (見つからなければ null)
    async findById(id) {
      const row = await db.tenant.findUnique({ where: { id } });
      return row ? toTenant(row) : null;
    },

    // バックフィル用のデフォルト Tenant ('default-tenant') を取得
    async findDefault() {
      const row = await db.tenant.findUnique({ where: { id: 'default-tenant' } });
      return row ? toTenant(row) : null;
    },

    // 新規テナント (組織) を 1 件作成する (運用者向けのテナント作成フォーム用)
    async create(input) {
      // Prisma 経由で行を作成。mode 未指定なら SMB 既定の lite で作る
      const row = await db.tenant.create({
        data: {
          name: input.name, // 組織名
          industry: input.industry ?? null, // 業種テンプレ識別子 (任意)
          mode: input.mode ?? 'lite', // 動作モード (既定 lite)
        },
      });
      // 作成行をドメイン型に変換して返す
      return toTenant(row);
    },

    // テナントの動作モード (lite | pro) を更新し、更新後の行をドメイン型で返す
    async updateMode(id, mode) {
      // 主キー (tenantId) で対象テナントを特定し mode 列のみ更新する
      const row = await db.tenant.update({ where: { id }, data: { mode } });
      // 更新後の行をドメイン型に詰め替えて返す
      return toTenant(row);
    },
  };
}
