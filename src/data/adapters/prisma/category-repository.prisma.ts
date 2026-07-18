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
    // カテゴリを 1 件作成 (または既存を返す) する冪等な操作 (Phase 3 業種テンプレ初期投入用)。
    // plain create ではなく upsert を使う理由:
    //   テナント作成フロー (create-tenant.ts) では同一の (tenantId, name) が @@unique 制約を持つため、
    //   ネットワーク障害や再送によるリトライで同じカテゴリを 2 回作成しようとすると P2002 が発生する。
    //   upsert により「存在しなければ INSERT、既に存在すれば更新なし」の冪等な動作にして、
    //   リトライに対して安全にする (§8 N+1 回避・§9 fail-safe)。
    async create(input) {
      // upsert: where 節で複合一意キー (tenantId + name) を指定して重複を検出する
      const row = await db.category.upsert({
        where: {
          // Prisma が @@unique([tenantId, name]) から自動生成する複合ユニーク識別子
          tenantId_name: { tenantId: input.tenantId, name: input.name },
        },
        // 既存行があっても何も更新しない (insert or ignore 相当)
        update: {},
        // 存在しない場合は新規作成する
        create: { name: input.name, tenantId: input.tenantId },
        // port 契約の CategorySummary 型に合わせた最小選択
        select: { id: true, name: true },
      });
      // 作成または取得した行 (id / name) を返す
      return row;
    },
  };
}
