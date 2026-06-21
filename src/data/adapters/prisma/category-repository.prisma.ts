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
    // カテゴリを 1 件新規作成して返す (Phase 3 業種テンプレ初期投入用)
    // tenantId は input に含まれているため、クロステナント作成は呼び出し側の責任で防ぐ
    async create(input) {
      // Prisma の create で name + tenantId を INSERT し、id と name だけ SELECT して返す
      const row = await db.category.create({
        data: { name: input.name, tenantId: input.tenantId }, // 作成データを渡す
        select: { id: true, name: true }, // port 契約の CategorySummary 型に合わせた最小選択
      });
      // 作成した行 (id / name) を返す
      return row;
    },
  };
}
