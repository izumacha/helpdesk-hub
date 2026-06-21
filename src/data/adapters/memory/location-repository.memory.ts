// Location リポジトリの契約 (port)
import type { LocationRepository } from '@/data/ports/location-repository';
// ドメイン型
import type { Location } from '@/domain/types';
// メモリストアと ID 生成ヘルパー
import { nextId, type Store } from './store';

// メモリ版 Location リポジトリを生成するファクトリ関数
export function makeLocationRepo(store: Store): LocationRepository {
  return {
    // テナント内の全拠点を名前昇順で返す
    async listByTenant(tenantId) {
      // テナントスコープで絞り込み
      const rows = [...store.locations.values()].filter(
        (loc) => loc.tenantId === tenantId,
      );
      // 拠点名でアルファベット/日本語順に昇順ソート
      rows.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
      return rows;
    },

    // ID + tenantId で 1 件取得
    async findById(id, tenantId) {
      // Map から取得し、テナントスコープを確認して返す
      const row = store.locations.get(id);
      // 他テナントの拠点なら null を返す (クロステナントアクセス防止)
      if (!row || row.tenantId !== tenantId) return null;
      return row;
    },

    // 新規拠点を作成する
    async create(input) {
      // テナント内で同名の拠点が存在しないかチェック (DB の @@unique 制約相当)
      const duplicate = [...store.locations.values()].find(
        (loc) => loc.tenantId === input.tenantId && loc.name === input.name,
      );
      if (duplicate) {
        // Prisma の Unique 制約違反に相当するエラーを throw する
        throw new Error(`Location name "${input.name}" already exists in tenant ${input.tenantId}`);
      }
      // 新しい拠点オブジェクトを作成する
      const location: Location = {
        id: nextId(store, 'loc'), // ストア内ユニーク ID を生成
        tenantId: input.tenantId, // 所属テナント
        name: input.name, // 拠点名
        description: input.description ?? null, // 補足説明 (未指定なら null)
        createdAt: new Date(), // 作成日時を現在時刻に設定
      };
      // ストアに追加する
      store.locations.set(location.id, location);
      return location;
    },

    // 拠点名・補足説明を更新する
    async update(id, tenantId, data) {
      // 対象拠点を取得してテナントスコープを確認する
      const existing = store.locations.get(id);
      if (!existing || existing.tenantId !== tenantId) {
        // 他テナントの拠点や存在しない拠点への更新は Prisma と同様にエラー
        throw new Error(`Location ${id} not found in tenant ${tenantId}`);
      }
      // 既存オブジェクトに差分を上書きする
      const updated: Location = {
        ...existing,
        // data.name が undefined なら既存値を維持する
        name: data.name ?? existing.name,
        // data.description が undefined なら既存値を維持し、null なら null を格納する
        description: data.description !== undefined ? data.description : existing.description,
      };
      // ストアに上書き保存する
      store.locations.set(id, updated);
      return updated;
    },

    // 拠点を削除する (紐づくチケットの locationId は null に戻す)
    async delete(id, tenantId) {
      // テナントスコープを確認してから削除する
      const existing = store.locations.get(id);
      // 他テナントや存在しない拠点への削除は no-op (DB の deleteMany と同じ動作)
      if (!existing || existing.tenantId !== tenantId) return;
      // ストアから拠点を削除する
      store.locations.delete(id);
      // この拠点に紐づくチケットの locationId を null に戻す (ON DELETE SET NULL 相当)
      for (const ticket of store.tickets.values()) {
        if (ticket.locationId === id) {
          store.tickets.set(ticket.id, { ...ticket, locationId: null });
        }
      }
    },
  };
}
