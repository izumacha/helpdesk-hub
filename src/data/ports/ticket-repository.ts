// ドメイン型 (チケット関連) とフィルター関連の基本型をインポート
import type {
  Priority,
  Ticket,
  TicketStatus,
  TicketWithRefs,
  UserSummary,
  TicketComment,
  TicketHistory,
} from '@/domain/types';
import type { Page, Sort, TextFilter } from './filters';

// チケット一覧の絞り込み条件
export interface TicketListFilter {
  creatorId?: string; // 起票者で絞る (依頼者ロールはこれを必ず付与)
  /** Searches title OR body. */
  text?: TextFilter; // タイトルまたは本文の部分一致
  status?: TicketStatus; // 状態で絞る
  priority?: Priority; // 優先度で絞る
  categoryId?: string; // カテゴリで絞る
  /**
   * `undefined` = no filter, `null` = only unassigned,
   * otherwise = exact match on assigneeId.
   */
  assigneeId?: string | null; // 担当者条件 (null は未アサインのみ)
}

// チケット詳細画面用の型 (コメント/履歴/FAQ 候補を同梱)
export interface TicketDetail extends TicketWithRefs {
  comments: Array<TicketComment & { author: UserSummary }>; // コメント + 書き込み者
  histories: Array<TicketHistory & { changedBy: UserSummary }>; // 履歴 + 変更者
  faqCandidate: { id: string } | null; // 紐づく FAQ 候補 (なければ null)
}

// 担当者別の保持チケット件数を表す行 (ダッシュボード用)
export interface AssigneeWorkloadRow {
  assigneeId: string | null; // 担当者 ID (未アサイン集計は null)
  count: number; // 件数
}

// ダッシュボード一括取得の戻り値 (ステータス別件数 / SLA 超過 / 担当者別ワークロード)
export interface DashboardStats {
  byStatus: Record<TicketStatus, number>; // 7 状態それぞれの件数 (該当なしは 0)
  slaOverdue: number; // SLA 超過件数 (未解決のうち期限切れ)
  workload: AssigneeWorkloadRow[]; // 担当者別の保持件数 (件数降順)
}

// チケット新規作成用の入力値
export interface CreateTicketInput {
  title: string; // 件名
  body: string; // 本文
  priority: Priority; // 優先度
  categoryId: string | null; // カテゴリ (無指定は null)
  creatorId: string; // 起票者 ID
  tenantId: string; // 所属テナント ID (マルチテナント化のキー)
  firstResponseDueAt?: Date | null; // 初回応答期限 (SLA)
  resolutionDueAt?: Date | null; // 解決期限 (SLA)
}

// エスカレーション適用時の入力値
export interface MarkEscalatedInput {
  reason: string; // エスカレーション理由
  at: Date; // エスカレーション実行日時
}

// チケットリポジトリの契約 (port)
// 全メソッドの ID 系引数は tenantId 必須化済。テナント越境参照/更新を Adapter 層で遮断する
export interface TicketRepository {
  // ID + tenantId で 1 件取得 (最小フィールド)。他テナントの ID なら null を返す
  findById(id: string, tenantId: string): Promise<Ticket | null>;
  // ID + tenantId で関連ユーザー/カテゴリ付きで 1 件取得
  findByIdWithRefs(id: string, tenantId: string): Promise<TicketWithRefs | null>;
  // ID + tenantId で詳細ページ用に 1 件取得 (コメント/履歴/FAQ 候補を同梱)
  findByIdWithDetail(id: string, tenantId: string): Promise<TicketDetail | null>;

  // 一覧取得 (絞り込み + ページング + ソート、tenantId スコープ)
  list(args: {
    filter: TicketListFilter;
    page: Page;
    sort?: Sort<'createdAt'>;
    tenantId: string; // テナントスコープ (必須)
  }): Promise<TicketWithRefs[]>;

  // 件数取得 (ページング用、tenantId スコープ)
  count(filter: TicketListFilter, tenantId: string): Promise<number>;

  /**
   * ダッシュボード用の一括統計取得。
   * - `creatorId` は **`byStatus` にのみ作用** する (依頼者ロール向けスコープ)
   * - `slaOverdue` / `workload` は常に全件対象 (担当者向け指標)。
   *   呼び出し側が role で表示制御する前提
   * - `tenantId` で当該テナント内のチケットだけを集計対象に絞る
   */
  dashboardStats(args: {
    creatorId?: string; // byStatus を起票者で絞る (省略時は全件)
    now: Date; // SLA 超過判定の基準時刻
    excludeStatusesForWorkload: TicketStatus[]; // ワークロード集計で除外する状態
    tenantId: string; // テナントスコープ (必須)
  }): Promise<DashboardStats>; // 上記 3 指標をまとめて返す

  create(input: CreateTicketInput): Promise<TicketWithRefs>; // 新規作成 (input.tenantId 必須)
  // 状態更新 (tenantId スコープ。他テナントの ID なら 0 件更新で no-op)
  updateStatus(
    id: string,
    status: TicketStatus,
    resolvedAt: Date | null,
    tenantId: string,
  ): Promise<void>;
  // 優先度更新 (tenantId スコープ)
  updatePriority(id: string, priority: Priority, tenantId: string): Promise<void>;
  // 担当者更新 (tenantId スコープ。null で未アサイン)
  updateAssignee(id: string, assigneeId: string | null, tenantId: string): Promise<void>;
  // エスカレーション状態にする (tenantId スコープ)
  markEscalated(id: string, args: MarkEscalatedInput, tenantId: string): Promise<void>;
}
