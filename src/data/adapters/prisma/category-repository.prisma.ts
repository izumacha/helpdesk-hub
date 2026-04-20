// カテゴリリポジトリの契約 (port) と、Prisma クライアント共通型をインポート
import type { CategoryRepository } from '@/data/ports/category-repository';
import type { PrismaLike } from './types';

// Prisma クライアントを使ったカテゴリリポジトリを生成する関数
export function makeCategoryRepo(db: PrismaLike): CategoryRepository {
  return {
    // 全カテゴリを名前昇順で取得
    async list() {
      // Prisma の findMany で全件取得 (select で列を限定)
      const rows = await db.category.findMany({
        orderBy: { name: 'asc' }, // 名前昇順
        select: { id: true, name: true }, // id と name だけ取得
      });
      // 結果をそのまま返す (port 契約と同じ形)
      return rows;
    },
    // ID 指定で 1 件取得 (見つからなければ null)
    async findById(id) {
      // findUnique で主キー検索
      return db.category.findUnique({
        where: { id },
        select: { id: true, name: true },
      });
    },
  };
}
