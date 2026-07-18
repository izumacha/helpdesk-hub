// Phase 4 多拠点: 店舗・拠点リポジトリの契約 (port)
// docs/smb-dx-pivot-plan.md Phase 4「多店舗・多拠点対応（テナント内サブグループ）」

// 拠点ドメイン型
import type { Location } from '@/domain/types';
// 「表示用 / 一括処理用」2 段クランプの共通ロジック (category-repository.ts と重複させない)
import { resolveListLimit } from '@/data/ports/list-limit';

// テナント内の拠点一覧の既定上限件数 (§8 一覧取得は必ず上限を持たせる)。UI 表示 (設定画面の
// 拠点管理・ダッシュボードの拠点フィルタ・チケット詳細/一覧のプルダウン) 向けの規模感で、
// FAQ_LIST_LIMIT / PAGE_LIMIT と揃える。拠点作成は §4.1 で 1 分あたりのレート制限を設けているが、
// それは作成 "速度" しか抑えず累計件数には上限が無かったため、一覧取得側にも上限を追加する
export const LOCATION_LIST_LIMIT = 200;

// CSV インポート (import-tickets.ts) の「拠点」列名前解決のように、テナントの拠点を
// 漏れなく引く必要がある網羅的な用途向けの上限。監査で発見したギャップ対応: 当初
// LOCATION_LIST_LIMIT を listByTenant の唯一の上限にしたところ、CSV インポートの名前解決
// (buildNameToIdMap) がこの一覧を丸ごと使って名前→ID のルックアップ表を作る設計だったため、
// 201 件目以降の拠点が対応表から漏れ、実在する拠点名なのに「拠点が見つかりません」という
// 誤った検証エラーになっていた。表示用の上限 (LOCATION_LIST_LIMIT) とは別に、一括処理向けの
// 上限を分けて持つ (`GET /api/audit/export` が画面表示用の PAGE_LIMIT とは別に
// MAX_AUDIT_EXPORT_ROWS を持つのと同じ「表示用と一括処理用で上限を分ける」考え方)
export const LOCATION_LIST_MATCHING_LIMIT = 10_000;

// 呼び出し側が指定した limit (未指定なら LOCATION_LIST_LIMIT) を LOCATION_LIST_MATCHING_LIMIT
// 以下にクランプする (resolveFaqListLimit と同じ「アダプタ層での多層防御クランプ」方針。
// 未指定時に低い表示用の既定値、指定時でも高い網羅用の上限を超えさせない)
export function resolveLocationListLimit(requested?: number): number {
  return resolveListLimit(requested, LOCATION_LIST_LIMIT, LOCATION_LIST_MATCHING_LIMIT);
}

// 拠点リポジトリの契約 (port)。テナントスコープで CRUD 操作を提供する
export interface LocationRepository {
  // テナント内の全拠点を名前昇順で取得する。opts.limit 省略時は LOCATION_LIST_LIMIT (表示用)。
  // CSV インポートの名前解決など網羅性が必要な用途は opts.limit に LOCATION_LIST_MATCHING_LIMIT
  // を渡す (Adapter 側でその値を上限にクランプする)
  listByTenant(tenantId: string, opts?: { limit?: number }): Promise<Location[]>;
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
