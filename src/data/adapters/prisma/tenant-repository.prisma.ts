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
  };
}
