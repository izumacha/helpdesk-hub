// カテゴリリポジトリの契約 (port) と、Prisma クライアント共通型をインポート
import type { CategoryRepository } from '@/data/ports/category-repository';
import type { PrismaLike } from './types';

// Prisma クライアントを使ったカテゴリリポジトリを生成する関数
export function makeCategoryRepo(db: PrismaLike): CategoryRepository {
  return {
    // 当該テナントのカテゴリを名前昇順で取得
    async list(tenantId) {
      // Prisma の findMany で tenantId スコープのみ全件取得
      const rows = await db.category.findMany({
        where: { tenantId }, // テナントスコープ (必須)
        orderBy: { name: 'asc' }, // 名前昇順
        select: { id: true, name: true }, // id と name だけ取得
      });
      // 結果をそのまま返す (port 契約と同じ形)
      return rows;
    },
    // ID 指定 + tenantId スコープで 1 件取得 (見つからなければ null)
    // 他テナントのカテゴリ ID を渡されても null を返すことでクロステナント参照を遮断する
    async findById(id, tenantId) {
      // findFirst で id と tenantId の AND 一致を検索 (findUnique は複合条件不可)
      return db.category.findFirst({
        where: { id, tenantId },
        select: { id: true, name: true },
      });
    },
  };
}
