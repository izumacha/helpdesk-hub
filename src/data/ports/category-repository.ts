// カテゴリの一覧表示などに使う軽量なカテゴリ情報
export interface CategorySummary {
  id: string; // カテゴリ ID
  name: string; // カテゴリ名
}

// テナント内のカテゴリ一覧の上限件数 (§8 一覧取得は必ず上限を持たせる)。
// LOCATION_LIST_LIMIT / FAQ_LIST_LIMIT と同じ規模感に揃える
export const CATEGORY_LIST_LIMIT = 200;

// カテゴリ取得用リポジトリの契約 (port)
// 全メソッドが tenantId 必須化済み。テナント越境参照を Adapter 層で遮断する
export interface CategoryRepository {
  // 当該テナントのカテゴリ一覧を取得 (上限 CATEGORY_LIST_LIMIT 件)
  list(tenantId: string): Promise<CategorySummary[]>;
  // ID 指定で 1 件取得 (他テナントの ID なら null を返す)
  findById(id: string, tenantId: string): Promise<CategorySummary | null>;
  // カテゴリを 1 件新規作成して返す (Phase 3 業種テンプレ初期投入用)
  create(input: { name: string; tenantId: string }): Promise<CategorySummary>;
}
