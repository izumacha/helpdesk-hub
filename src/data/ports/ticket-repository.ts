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
   * `undefined` = no filter, `null` or `'unassigned'` = only unassigned,
   * otherwise = exact match on assigneeId.
   */
  assigneeId?: string | null | 'unassigned'; // 担当者条件 (未アサイン指定も可能)
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

// チケット新規作成用の入力値
export interface CreateTicketInput {
  title: string; // 件名
  body: string; // 本文
  priority: Priority; // 優先度
  categoryId: string | null; // カテゴリ (無指定は null)
  creatorId: string; // 起票者 ID
  firstResponseDueAt?: Date | null; // 初回応答期限 (SLA)
  resolutionDueAt?: Date | null; // 解決期限 (SLA)
}

// エスカレーション適用時の入力値
export interface MarkEscalatedInput {
  reason: string; // エスカレーション理由
  at: Date; // エスカレーション実行日時
}

// チケットリポジトリの契約 (port)
export interface TicketRepository {
  findById(id: string): Promise<Ticket | null>; // ID で 1 件取得 (最小フィールド)
  findByIdWithRefs(id: string): Promise<TicketWithRefs | null>; // 関連ユーザー/カテゴリ付きで 1 件取得
  findByIdWithDetail(id: string): Promise<TicketDetail | null>; // 詳細ページ用に 1 件取得

  // 一覧取得 (絞り込み + ページング + ソート)
  list(args: {
    filter: TicketListFilter;
    page: Page;
    sort?: Sort<'createdAt'>;
  }): Promise<TicketWithRefs[]>;

  count(filter: TicketListFilter): Promise<number>; // 件数取得 (ページング用)

  countByStatus(args: { creatorId?: string; status: TicketStatus }): Promise<number>; // 状態別件数
  countSlaOverdue(now: Date): Promise<number>; // SLA 超過件数 (ダッシュボード用)
  workloadByAssignee(args: { excludeStatuses: TicketStatus[] }): Promise<AssigneeWorkloadRow[]>; // 担当者別件数

  create(input: CreateTicketInput): Promise<TicketWithRefs>; // 新規作成
  updateStatus(id: string, status: TicketStatus, resolvedAt: Date | null): Promise<void>; // 状態更新
  updatePriority(id: string, priority: Priority): Promise<void>; // 優先度更新
  updateAssignee(id: string, assigneeId: string | null): Promise<void>; // 担当者更新
  markEscalated(id: string, args: MarkEscalatedInput): Promise<void>; // エスカレーション状態にする
}
