// カテゴリリポジトリの契約 (port)・一覧の上限クランプ関数と、テスト用メモリストア型をインポート
import {
  resolveCategoryListLimit,
  type CategoryRepository,
} from '@/data/ports/category-repository';
import { nextId, type Store } from './store';

// メモリストアを使ったカテゴリリポジトリを生成するファクトリ関数
export function makeCategoryRepo(store: Store): CategoryRepository {
  return {
    // 当該テナントのカテゴリを名前昇順で取得する (opts.limit 省略時は表示用の既定上限)
    async list(tenantId, opts) {
      return [...store.categories.values()] // Map から配列化
        .filter((c) => c.tenantId === tenantId) // テナントで絞る
        .map((c) => ({ id: c.id, name: c.name })) // 返却用に id/name だけ抽出
        .sort((a, b) => a.name.localeCompare(b.name)) // 名前でロケール順に並び替え
        .slice(0, resolveCategoryListLimit(opts?.limit)); // §8 一覧取得は必ず上限を持たせる (呼び出し元の指定値をさらにクランプ)
    },
    // ID 指定 + tenantId スコープで 1 件取得 (存在しないか他テナントなら null)
    async findById(id, tenantId) {
      const c = store.categories.get(id); // Map から取得
      // 存在 & テナント一致のときだけ要約を返す
      if (!c || c.tenantId !== tenantId) return null;
      return { id: c.id, name: c.name };
    },
    // カテゴリを 1 件新規作成する。同テナント内の重複名は Prisma の一意制約違反相当のエラーを
    // throw する (LocationRepository.create と同じ契約に統一。フォローアップ 2026-07-21)
    async create(input) {
      // 同テナント + 同名のカテゴリが既にストア内にあればエラー (DB の @@unique 制約相当)
      const duplicate = [...store.categories.values()].find(
        (c) => c.tenantId === input.tenantId && c.name === input.name,
      );
      if (duplicate) {
        throw new Error(`Category name "${input.name}" already exists in tenant ${input.tenantId}`);
      }
      // ストアのカウンタを使って一意 ID を生成する ('cat' プレフィックス)
      const id = nextId(store, 'cat');
      // 新しいカテゴリ行をインメモリストアの CategoryRow 型に合わせて組み立てる
      const row = {
        id, // 生成した ID
        name: input.name, // カテゴリ名
        tenantId: input.tenantId, // 所属テナント ID
        createdAt: new Date(), // 作成日時 (現在時刻)
      };
      // ストアの Map に登録する
      store.categories.set(id, row);
      // port 契約の CategorySummary 型 (id / name のみ) で返す
      return { id: row.id, name: row.name };
    },

    // カテゴリ名を更新する (LocationRepository.update と同じ CAS 契約)
    async update(id, tenantId, data, expected) {
      // 対象カテゴリを取得してテナントスコープを確認する
      const existing = store.categories.get(id);
      if (!existing || existing.tenantId !== tenantId) {
        // 他テナントのカテゴリや存在しないカテゴリへの更新は Prisma と同様にエラー
        throw new Error(`Category ${id} not found in tenant ${tenantId}`);
      }
      // CAS: expected が渡されていれば、現在値がそれと一致するときだけ更新する
      if (expected && existing.name !== expected.name) {
        // 読み取り後に他の管理者が編集していた (競合) ため null を返し、上書きしない
        return null;
      }
      // リネーム先が同テナントの別カテゴリと衝突しないか確認する (Prisma の一意制約と同じ挙動)
      const duplicate = [...store.categories.values()].find(
        (c) => c.tenantId === tenantId && c.name === data.name && c.id !== id,
      );
      if (duplicate) {
        throw new Error(`Category name "${data.name}" already exists in tenant ${tenantId}`);
      }
      // 既存オブジェクトに差分を上書きする
      const updated = { ...existing, name: data.name };
      // ストアに上書き保存する
      store.categories.set(id, updated);
      return { id: updated.id, name: updated.name };
    },

    // カテゴリを削除する (紐づくチケットの categoryId は null に戻す)
    async delete(id, tenantId) {
      // テナントスコープを確認してから削除する
      const existing = store.categories.get(id);
      // 他テナントや存在しないカテゴリへの削除は no-op (DB の deleteMany と同じ動作)
      if (!existing || existing.tenantId !== tenantId) return;
      // ストアからカテゴリを削除する
      store.categories.delete(id);
      // このカテゴリに紐づくチケットの categoryId を null に戻す (ON DELETE SetNull 相当)
      for (const ticket of store.tickets.values()) {
        if (ticket.categoryId === id) {
          store.tickets.set(ticket.id, { ...ticket, categoryId: null });
        }
      }
    },
  };
}
