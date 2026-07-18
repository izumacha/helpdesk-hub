// Location リポジトリの契約 (port) と一覧の上限クランプ関数
import {
  resolveLocationListLimit,
  type LocationRepository,
} from '@/data/ports/location-repository';
// ドメイン型
import type { Location } from '@/domain/types';
// Prisma の Location 行型
import type { Prisma } from '@/generated/prisma';
// Prisma クライアント/トランザクション共通型
import type { PrismaLike } from './types';

// Prisma の Location 行 (include なし) の型エイリアス
type LocationRow = Prisma.LocationGetPayload<Record<string, never>>;

// Prisma の Location 行をドメイン型 Location に変換する関数
function toLocation(row: LocationRow): Location {
  // 必要なフィールドだけを詰め替えて返す (余計なフィールドは付与しない)
  return {
    id: row.id,
    tenantId: row.tenantId, // 所属テナント (マルチテナント化のキー)
    name: row.name, // 拠点名
    description: row.description, // 補足説明 (null なら未設定)
    createdAt: row.createdAt, // 作成日時
  };
}

// Prisma クライアントを使った Location リポジトリを生成するファクトリ関数
export function makeLocationRepo(db: PrismaLike): LocationRepository {
  return {
    // テナント内の全拠点を名前昇順で取得する (opts.limit 省略時は表示用の既定上限)
    async listByTenant(tenantId, opts) {
      // テナントスコープで絞り込み、拠点名で昇順ソートして取得する
      const rows = await db.location.findMany({
        where: { tenantId },
        orderBy: { name: 'asc' },
        take: resolveLocationListLimit(opts?.limit), // §8 一覧取得は必ず上限を持たせる (呼び出し元の指定値をさらにクランプ)
      });
      // 各行をドメイン型に変換して返す
      return rows.map(toLocation);
    },

    // ID + tenantId で 1 件取得 (他テナントの ID なら null を返す)
    async findById(id, tenantId) {
      // 主キーとテナント ID の両方を条件にすることでクロステナントアクセスを防ぐ
      const row = await db.location.findFirst({ where: { id, tenantId } });
      // 見つからない (他テナントの行含む) なら null を返す
      return row ? toLocation(row) : null;
    },

    // 新規拠点を作成する (name はテナント内一意制約あり)
    async create(input) {
      // テナント ID はセッション由来の値のみ渡すこと (呼び出し側の責任)
      const row = await db.location.create({
        data: {
          tenantId: input.tenantId, // 所属テナント
          name: input.name, // 拠点名
          description: input.description ?? null, // 補足説明 (未指定なら null)
        },
      });
      // 作成した行をドメイン型に変換して返す
      return toLocation(row);
    },

    // 拠点名・補足説明を更新する (tenantId スコープで他テナントは not-found エラー)
    async update(id, tenantId, data) {
      // まず対象拠点がこのテナントに属するか findFirst で確認する。
      // db.location.update の where は PK (id) のみで解決されるため tenantId は AND にならない。
      // deleteMany は任意 WHERE をサポートするが update は @@unique 経由でしか複合条件を取れない。
      // 事前 findFirst でテナント所有を検証してから id のみで更新することでクロステナントを防ぐ。
      const existing = await db.location.findFirst({ where: { id, tenantId } });
      // 見つからない場合は他テナントの行か存在しない行 — 更新を拒否する
      if (!existing) {
        throw new Error(`Location not found: ${id}`);
      }
      // テナント所有を確認後、PK だけで更新する (Prisma の update は PK 必須)
      const row = await db.location.update({
        where: { id },
        data: {
          // undefined なら Prisma が該当フィールドをスキップする
          name: data.name,
          description: data.description,
        },
      });
      // 更新後の行をドメイン型に変換して返す
      return toLocation(row);
    },

    // 拠点を削除する。紐づくチケットの locationId は ON DELETE SET NULL で自動的に null 化される
    async delete(id, tenantId) {
      // テナント ID を条件に含めることでクロステナント削除を防ぐ
      await db.location.deleteMany({ where: { id, tenantId } });
      // deleteMany は他テナントの行を削除しないため void を返す (0 件削除は無視)
    },
  };
}
