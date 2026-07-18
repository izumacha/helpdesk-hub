// Phase 4 多拠点: 店舗・拠点リポジトリの契約 (port)
// docs/smb-dx-pivot-plan.md Phase 4「多店舗・多拠点対応（テナント内サブグループ）」

// 拠点ドメイン型
import type { Location } from '@/domain/types';

// テナント内の拠点一覧の上限件数 (§8 一覧取得は必ず上限を持たせる)。FAQ_LIST_LIMIT / PAGE_LIMIT
// と同じ規模感に揃える。拠点作成は §4.1 で 1 分あたりのレート制限を設けているが、それは作成
// "速度" しか抑えず累計件数には上限が無かったため、一覧取得側にも上限を追加する
export const LOCATION_LIST_LIMIT = 200;

// 拠点リポジトリの契約 (port)。テナントスコープで CRUD 操作を提供する
export interface LocationRepository {
  // テナント内の全拠点を名前昇順で取得する (上限 LOCATION_LIST_LIMIT 件)
  listByTenant(tenantId: string): Promise<Location[]>;
  // ID + tenantId で 1 件取得 (他テナントの ID なら null を返す)
  findById(id: string, tenantId: string): Promise<Location | null>;
  // 新規拠点を作成する (name はテナント内一意)
  create(input: {
    tenantId: string; // 所属テナント (セッション由来のみ許可。クロステナント作成防止)
    name: string; // 拠点名 (例: 渋谷本店、第一工場)
    description?: string | null; // 補足説明 (任意)
  }): Promise<Location>;
  // 拠点名・補足説明を更新する (tenantId スコープで他テナントの ID は no-op)
  update(
    id: string,
    tenantId: string,
    data: { name?: string; description?: string | null },
  ): Promise<Location>;
  // 拠点を削除する。紐づくチケットの locationId は DB の ON DELETE SET NULL で null になる
  delete(id: string, tenantId: string): Promise<void>;
}
