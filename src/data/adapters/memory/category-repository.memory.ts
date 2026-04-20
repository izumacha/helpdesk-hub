// カテゴリリポジトリの契約 (port) と、テスト用メモリストア型をインポート
import type { CategoryRepository } from '@/data/ports/category-repository';
import type { Store } from './store';

// メモリストアを使ったカテゴリリポジトリを生成するファクトリ関数
export function makeCategoryRepo(store: Store): CategoryRepository {
  return {
    // 全カテゴリを名前昇順で取得
    async list() {
      return [...store.categories.values()] // Map から配列化
        .map((c) => ({ id: c.id, name: c.name })) // 返却用に id/name だけ抽出
        .sort((a, b) => a.name.localeCompare(b.name)); // 名前でロケール順に並び替え
    },
    // ID 指定で 1 件取得 (存在しなければ null)
    async findById(id) {
      const c = store.categories.get(id); // Map から取得
      return c ? { id: c.id, name: c.name } : null; // 見つかれば要約を返す
    },
  };
}
