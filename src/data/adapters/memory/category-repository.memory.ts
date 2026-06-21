// カテゴリリポジトリの契約 (port) と、テスト用メモリストア型をインポート
import type { CategoryRepository } from '@/data/ports/category-repository';
import { nextId, type Store } from './store';

// メモリストアを使ったカテゴリリポジトリを生成するファクトリ関数
export function makeCategoryRepo(store: Store): CategoryRepository {
  return {
    // 当該テナントのカテゴリを名前昇順で取得
    async list(tenantId) {
      return [...store.categories.values()] // Map から配列化
        .filter((c) => c.tenantId === tenantId) // テナントで絞る
        .map((c) => ({ id: c.id, name: c.name })) // 返却用に id/name だけ抽出
        .sort((a, b) => a.name.localeCompare(b.name)); // 名前でロケール順に並び替え
    },
    // ID 指定 + tenantId スコープで 1 件取得 (存在しないか他テナントなら null)
    async findById(id, tenantId) {
      const c = store.categories.get(id); // Map から取得
      // 存在 & テナント一致のときだけ要約を返す
      if (!c || c.tenantId !== tenantId) return null;
      return { id: c.id, name: c.name };
    },
    // カテゴリを 1 件新規作成してストアに登録する (Phase 3 業種テンプレ初期投入用)
    async create(input) {
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
  };
}
