// 「表示用 / 一括処理用」2 段クランプの共通ロジック (location-repository.ts と重複させない)
import { resolveListLimit } from '@/data/ports/list-limit';

// カテゴリの一覧表示などに使う軽量なカテゴリ情報
export interface CategorySummary {
  id: string; // カテゴリ ID
  name: string; // カテゴリ名
}

// テナント内のカテゴリ一覧の既定上限件数 (§8 一覧取得は必ず上限を持たせる)。UI 表示向けの
// 規模感で、LOCATION_LIST_LIMIT / FAQ_LIST_LIMIT と揃える
export const CATEGORY_LIST_LIMIT = 200;

// CSV インポート (import-tickets.ts) の「カテゴリ」列名前解決のように、テナントのカテゴリを
// 漏れなく引く必要がある網羅的な用途向けの上限 (LOCATION_LIST_MATCHING_LIMIT と同じ理由・
// 同じ規模感。監査で発見したギャップ対応の詳細は location-repository.ts のコメント参照)
export const CATEGORY_LIST_MATCHING_LIMIT = 10_000;

// 呼び出し側が指定した limit (未指定なら CATEGORY_LIST_LIMIT) を CATEGORY_LIST_MATCHING_LIMIT
// 以下にクランプする (resolveFaqListLimit / resolveLocationListLimit と同じ方針)
export function resolveCategoryListLimit(requested?: number): number {
  return resolveListLimit(requested, CATEGORY_LIST_LIMIT, CATEGORY_LIST_MATCHING_LIMIT);
}

// カテゴリ取得用リポジトリの契約 (port)
// 全メソッドが tenantId 必須化済み。テナント越境参照を Adapter 層で遮断する
export interface CategoryRepository {
  // 当該テナントのカテゴリ一覧を取得する。opts.limit 省略時は CATEGORY_LIST_LIMIT (表示用)。
  // CSV インポートの名前解決など網羅性が必要な用途は opts.limit に CATEGORY_LIST_MATCHING_LIMIT
  // を渡す (Adapter 側でその値を上限にクランプする)
  list(tenantId: string, opts?: { limit?: number }): Promise<CategorySummary[]>;
  // ID 指定で 1 件取得 (他テナントの ID なら null を返す)
  findById(id: string, tenantId: string): Promise<CategorySummary | null>;
  // カテゴリを 1 件新規作成して返す (Phase 3 業種テンプレ初期投入用)
  create(input: { name: string; tenantId: string }): Promise<CategorySummary>;
}
