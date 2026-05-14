// カテゴリリポジトリの契約 (port) と、テスト用メモリストア型をインポート
import type { CategoryRepository } from '@/data/ports/category-repository';
import type { Store } from './store';

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
  };
}
