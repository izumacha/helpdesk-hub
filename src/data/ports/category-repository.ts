// カテゴリの一覧表示などに使う軽量なカテゴリ情報
export interface CategorySummary {
  id: string; // カテゴリ ID
  name: string; // カテゴリ名
}

// カテゴリ取得用リポジトリの契約 (port)
export interface CategoryRepository {
  list(): Promise<CategorySummary[]>; // 全カテゴリを取得する
  // ID 指定で 1 件取得。tenantId 必須でテナント越境参照を防止する
  // (Phase 0: 全 Port を tenant スコープ化するまでの第一歩)
  findById(id: string, tenantId: string): Promise<CategorySummary | null>;
}
