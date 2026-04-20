// カテゴリの一覧表示などに使う軽量なカテゴリ情報
export interface CategorySummary {
  id: string; // カテゴリ ID
  name: string; // カテゴリ名
}

// カテゴリ取得用リポジトリの契約 (port)
export interface CategoryRepository {
  list(): Promise<CategorySummary[]>; // 全カテゴリを取得する
  findById(id: string): Promise<CategorySummary | null>; // ID 指定で 1 件取得 (無ければ null)
}
