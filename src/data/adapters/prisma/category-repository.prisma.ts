// カテゴリリポジトリの契約 (port)・一覧の上限クランプ関数と、Prisma クライアント共通型をインポート
import {
  resolveCategoryListLimit,
  type CategoryRepository,
} from '@/data/ports/category-repository';
import type { PrismaLike } from './types';

// Prisma クライアントを使ったカテゴリリポジトリを生成する関数
export function makeCategoryRepo(db: PrismaLike): CategoryRepository {
  return {
    // 当該テナントのカテゴリを名前昇順で取得する (opts.limit 省略時は表示用の既定上限)
    async list(tenantId, opts) {
      // Prisma の findMany で tenantId スコープのみを取得
      const rows = await db.category.findMany({
        where: { tenantId }, // テナントスコープ (必須)
        orderBy: { name: 'asc' }, // 名前昇順
        select: { id: true, name: true }, // id と name だけ取得
        take: resolveCategoryListLimit(opts?.limit), // §8 一覧取得は必ず上限を持たせる (呼び出し元の指定値をさらにクランプ)
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
    // カテゴリを 1 件新規作成する。name はテナント内一意 (@@unique([tenantId, name])) —
    // 重複時は Prisma が P2002 を throw する (LocationRepository.create と同じ契約に統一。
    // フォローアップ 2026-07-21: 業種テンプレ初期投入 (tenant-provisioning.ts) は Postgres の
    // インタラクティブトランザクション内で P2002 を捕捉しても後続の文が壊れてしまうため、
    // 一意制約違反を捕捉する側ではなく、呼び出し前にテンプレート内の重複名を除いて
    // 衝突そのものを起こさない設計にしてある)
    async create(input) {
      const row = await db.category.create({
        data: { name: input.name, tenantId: input.tenantId },
        // port 契約の CategorySummary 型に合わせた最小選択
        select: { id: true, name: true },
      });
      return row;
    },

    // カテゴリ名を更新する (tenantId スコープで他テナントは not-found エラー)
    async update(id, tenantId, data, expected) {
      // まず対象カテゴリがこのテナントに属するか findFirst で確認する
      // (LocationRepository.update と同じ「事前 findFirst でテナント所有を検証してから
      // id のみで更新する」構成。db.category.update の where は PK のみで tenantId は AND にならない)
      const existing = await db.category.findFirst({ where: { id, tenantId } });
      if (!existing) {
        throw new Error(`Category not found: ${id}`);
      }

      // expected が渡された場合は CAS (compare-and-swap) 経路 (LocationRepository.update と同じ)
      if (expected) {
        const result = await db.category.updateMany({
          where: { id, tenantId, name: expected.name },
          data: { name: data.name },
        });
        // 0 件更新 = 直前の読み取り後に他の管理者が値を変えていた (競合)
        if (result.count === 0) return null;
        const row = await db.category.findFirst({
          where: { id, tenantId },
          select: { id: true, name: true },
        });
        if (!row) return null;
        return row;
      }

      // expected 未指定: 従来どおりの無条件更新
      const row = await db.category.update({
        where: { id },
        data: { name: data.name },
        select: { id: true, name: true },
      });
      return row;
    },

    // カテゴリを削除する。紐づくチケットの categoryId は ON DELETE SetNull で自動的に null 化される
    async delete(id, tenantId) {
      // テナント ID を条件に含めることでクロステナント削除を防ぐ
      await db.category.deleteMany({ where: { id, tenantId } });
    },
  };
}
