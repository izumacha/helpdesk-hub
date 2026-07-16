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
// 添付ファイルのサマリ型 (詳細画面でサムネ表示する際に必要な最小情報)
import type { AttachmentSummary } from '@/domain/attachment-summary';
import type { Page, Sort, TextFilter } from './filters';

// チケット一覧の絞り込み条件
export interface TicketListFilter {
  creatorId?: string; // 起票者で絞る (依頼者ロールはこれを必ず付与)
  /** Searches title OR body. */
  text?: TextFilter; // タイトルまたは本文の部分一致
  status?: TicketStatus; // 状態で絞る
  statusIn?: TicketStatus[]; // 複数状態の OR 絞り込み (例: Open or InProgress)
  priority?: Priority; // 優先度で絞る
  categoryId?: string; // カテゴリで絞る
  /**
   * `undefined` = no filter, `null` = only unassigned,
   * otherwise = exact match on assigneeId.
   */
  assigneeId?: string | null; // 担当者条件 (null は未アサインのみ)
  locationId?: string | null; // 拠点 ID で絞る (Phase 4 多拠点。null は拠点未設定のみ)
  createdAfter?: Date; // この日時以降に作成されたチケットのみ (Phase 4 課金: 月間件数カウント用)
  /**
   * 期限切れ未解決のみを取得するフィルタ (Lite モードの「期限切れ」タブで使用)。
   * `now` 時点で `resolutionDueAt < now` かつ `resolvedAt IS NULL`、
   * かつ業務上「終わった」扱いの status (Resolved/Closed) は除外する。
   * 省略時はフィルタなし。
   */
  overdue?: { now: Date };
}

// findByIdWithDetail が返すコメント/履歴の既定件数上限。
// フォローアップ (2026-07-16 #4): 監査で発見したギャップ。findByIdWithDetail のネストした
// include (comments/histories) には上限が無く、CLAUDE.md §8「一覧取得は必ず上限・
// ページネーションを持たせる」に反していた (FAQ の list/listPublished と同種のギャップ。§4.11)。
// 単純な findMany の grep では見つからず、ネストした include の中に隠れていた。
// エスカレーション等で長期化したチケットはコメント/履歴が無制限に積み上がり得るため実害がある。
// FAQ_LIST_LIMIT / PAGE_LIMIT と同じ規模感に揃える
export const TICKET_DETAIL_COMMENTS_LIMIT = 200;
export const TICKET_DETAIL_HISTORY_LIMIT = 200;

// チケット詳細画面用の型 (コメント/履歴/FAQ 候補/添付を同梱)
export interface TicketDetail extends TicketWithRefs {
  // コメント + 書き込み者 + そのコメントに紐づく添付一覧 (古い順)。
  // TICKET_DETAIL_COMMENTS_LIMIT 件を超える場合は直近 (最新) の同件数のみを、
  // 古い順に並べ替えて返す (最も新しい会話が見えることを優先する。フォローアップ 2026-07-16 #4)
  comments: Array<
    TicketComment & {
      author: UserSummary;
      attachments: AttachmentSummary[];
    }
  >;
  // 履歴 + 変更者 (新しい順)。TICKET_DETAIL_HISTORY_LIMIT 件を超える場合は
  // 直近 (最新) の同件数のみを返す (フォローアップ 2026-07-16 #4)
  histories: Array<TicketHistory & { changedBy: UserSummary }>;
  // コメント/履歴それぞれの実件数 (上限による切り詰め前の総数)。
  // /code-review ultra 指摘対応 (2026-07-16 #4): comments.length/histories.length を
  // 件数表示に使うと、上限超過時に画面が実際より少ない件数を表示してしまい、かつ
  // 「一部が切り詰められている」ことを利用者に一切伝えられない (静かなデータ欠落)。
  // 呼び出し側 (チケット詳細画面) が「全 N 件中、直近 M 件を表示」と案内できるよう、
  // 切り詰め前の総数を別フィールドとして持たせる
  commentCount: number;
  historyCount: number;
  faqCandidate: { id: string } | null; // 紐づく FAQ 候補 (なければ null)
  // チケット本体に直接添付された画像 (コメント添付ではないもの。古い順)
  attachments: AttachmentSummary[];
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
  locationId?: string | null; // 拠点 ID (Phase 4 多拠点。未指定は null)
  // フォローアップ (2026-07-13): CSV インポートで「担当者」列を名前解決した ID (未指定は null=未アサイン)。
  // Web フォーム/メール/LINE 取り込みは起票時に担当者を指定できないため常に未指定のままになる
  assigneeId?: string | null;
  creatorId: string; // 起票者 ID
  tenantId: string; // 所属テナント ID (マルチテナント化のキー)
  status?: TicketStatus; // 初期ステータス (未指定なら DB 既定の New。Lite では 'Open'=未対応 で起票する)
  firstResponseDueAt?: Date | null; // 初回応答期限 (SLA)
  resolutionDueAt?: Date | null; // 解決期限 (SLA)
  // §3.1 フォローアップ (2026-07-10): CSV インポートで「状況」列が完了系ステータスを指定していた
  // 場合の解決日時 (インポート時刻)。未指定なら null (未解決のまま起票)
  resolvedAt?: Date | null;
  // フォローアップ (2026-07-13): CSV インポートで「状況」列がモードの初期状態以外を指定していた
  // 場合の初回応答日時 (インポート時刻)。resolvedAt と対になるフィールドで、既に着手/完了済みの
  // 行を「未応答」のまま起票してしまうと、Pro モードの SLA バッジ・品質メトリクス
  // (平均初回応答時間) が永久に不正確になる (§2.1.2 フォローアップと同種の欠落)。
  // 未指定なら null (未応答のまま起票。Web フォーム/メール/LINE 取り込みの既定動作)
  firstRespondedAt?: Date | null;
  // /code-review ultra 指摘対応 (2026-07-13): CSV インポートは resolvedAt/firstRespondedAt に
  // 取り込みバッチ開始時点の時刻 (now) を使うが、createdAt は DB 側の @default(now()) や
  // 各行の作成タイミングで個別に決まるため、複数行をループで作成する間に経過した時間の分だけ
  // createdAt が now より後になり、resolvedAt/firstRespondedAt が createdAt より「前」になって
  // 品質メトリクス (平均初回応答時間・平均解決時間) の AVG(resolvedAt - createdAt) が負値になり得る。
  // フォローアップ 2026-07-15 #3: 上記の負値防止のため、CSV の「起票日時」列が指定されていれば
  // (未来日時は validateImportRow が拒否済み) その値を createdAt として使い、列が無指定なら
  // 従来どおりこの now で上書きする。いずれの場合も resolvedAt/firstRespondedAt >= createdAt を保証する
  createdAt?: Date;
}

// エスカレーション適用時の入力値
export interface MarkEscalatedInput {
  reason: string; // エスカレーション理由
  at: Date; // エスカレーション実行日時
}

/**
 * 品質メトリクス (issue-backlog #25: 平均初回応答時間・平均解決時間・再オープン率)
 *
 * Pro モードのダッシュボードに表示し、対応品質の傾向を把握するために使う。
 * 集計対象チケットが 0 件の場合はデータ不足として各値を null で返す (0 との混同を避ける)。
 */
export interface QualityMetrics {
  /** 平均初回応答時間 (ミリ秒)。firstRespondedAt が設定されたチケットの平均値。集計対象なしなら null */
  avgFirstResponseMs: number | null;
  /** 平均解決時間 (ミリ秒)。resolvedAt が設定されたチケットの平均値。集計対象なしなら null */
  avgResolutionMs: number | null;
  /**
   * 再オープン率 (0.0〜1.0)。
   * 全チケットのうち「Resolved または Closed から Open に戻った履歴」を持つ割合。
   * 集計対象なしなら null
   */
  reopenRate: number | null;
  /** avgResolutionMs の計算に使った解決済みチケット件数 */
  resolvedCount: number;
  /** reopenRate の計算に使った全チケット件数 (分母)。再オープン率ラベルに表示する */
  totalCount: number;
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
    locationId?: string; // 拠点で絞る (Phase 4 多拠点。省略時は全拠点対象)
  }): Promise<DashboardStats>; // 上記 3 指標をまとめて返す

  /**
   * 品質メトリクスを算出して返す (issue-backlog #25)。
   * - avgFirstResponseMs : 初回応答があったチケットの平均初回応答時間 (ms)
   * - avgResolutionMs    : 解決済みチケットの平均解決時間 (ms)
   * - reopenRate         : 全チケット中「再オープンした」チケットの割合 (0.0〜1.0)
   * @param args.tenantId テナントスコープ (必須)
   * @param args.since    この日時以降に作成されたチケットのみ対象 (省略時は全期間)
   * @param args.locationId 拠点で絞る (Phase 4 多拠点。省略時は全拠点対象)
   */
  qualityMetrics(args: {
    tenantId: string;
    since?: Date;
    locationId?: string;
  }): Promise<QualityMetrics>;

  create(input: CreateTicketInput): Promise<TicketWithRefs>; // 新規作成 (input.tenantId 必須)
  // 状態更新 (tenantId スコープ。期待する現在状態 transition.from を where 条件に含めた原子的更新。
  // 読み取り後に別の操作が状態を変えていた場合 (check-then-act 競合) は 0 件更新 → false を返す。
  // ドメイン遷移表 (isValidTransition 等) による from→to の妥当性検証は呼び出し側の責務で、
  // ここは「読んだときの状態のまま変わっていないこと」だけを保証する (楽観的同時実行制御。
  // FaqRepository.updateStatus と同じ契約。フォローアップ 2026-07-15 #2: §1.4 で導入したこの契約を
  // 残課題として明記されていたチケット側にも適用した)
  updateStatus(
    id: string,
    transition: { from: TicketStatus; to: TicketStatus },
    resolvedAt: Date | null,
    tenantId: string,
  ): Promise<boolean>;
  // 優先度更新 (tenantId スコープ。期待する現在優先度 transition.from を where 条件に含めた
  // 原子的更新。読み取り後に別の操作が優先度を変えていた場合 (check-then-act 競合) は
  // 0 件更新 → false を返す (updateStatus/markEscalated と同じ契約。フォローアップ 2026-07-15 #3:
  // 優先度変更だけこの保護が無く、2 つの優先度変更が競合すると新しい優先度から再計算した
  // dueDates が後勝ちで静かに失われ得たギャップの解消)。
  // dueDates は呼び出し側 (update-ticket.ts) が mode-aware に再計算した新しい期限を渡す
  // (フォローアップ 2026-07-15: 優先度変更後も期限が旧優先度のまま固定され続け、SLA バッジが
  // 誤表示になっていたギャップの解消。Lite モードの resolutionDueAt は依頼者が手動指定した期日
  // であり優先度と無関係なので、呼び出し側は Pro モードのみ再計算して渡す)
  updatePriority(
    id: string,
    transition: { from: Priority; to: Priority },
    dueDates: { firstResponseDueAt: Date | null; resolutionDueAt: Date | null },
    tenantId: string,
  ): Promise<boolean>;
  // 担当者更新 (tenantId スコープ。null で未アサイン)。期待する現在担当者 transition.from を
  // where 条件に含めた原子的更新で、check-then-act 競合時 (0 件更新) は false を返す
  // (updateStatus/updatePriority/markEscalated と同じ契約。フォローアップ 2026-07-16:
  // 担当者・カテゴリ・拠点だけこの保護が無く、2 つの変更が競合すると片方が静かに失われた
  // うえ history の oldValue も不正確になり得たギャップの解消)
  updateAssignee(
    id: string,
    transition: { from: string | null; to: string | null },
    tenantId: string,
  ): Promise<boolean>;
  // カテゴリ更新 (tenantId スコープ。null で未分類。フォローアップ 2026-07-14 #4:
  // メール/LINE 取り込みチケットの事後変更を可能にするために追加)。updateAssignee と同じく
  // フォローアップ 2026-07-16 で CAS 保護を追加した
  updateCategory(
    id: string,
    transition: { from: string | null; to: string | null },
    tenantId: string,
  ): Promise<boolean>;
  // 拠点更新 (tenantId スコープ。null で未指定。フォローアップ 2026-07-14 #4: 同上)。
  // updateAssignee と同じく フォローアップ 2026-07-16 で CAS 保護を追加した
  updateLocation(
    id: string,
    transition: { from: string | null; to: string | null },
    tenantId: string,
  ): Promise<boolean>;
  // エスカレーション状態にする (tenantId スコープ)。期待する現在状態 expectedStatus を where 条件に
  // 含めた原子的更新で、check-then-act 競合時は false を返す (updateStatus と同じ契約。
  // フォローアップ 2026-07-15 #2)
  markEscalated(
    id: string,
    args: MarkEscalatedInput,
    expectedStatus: TicketStatus,
    tenantId: string,
  ): Promise<boolean>;
  // 初回応答日時を記録する (tenantId スコープ)。呼び出し側が「まだ未応答」を確認してから
  // 呼ぶ前提 (2 回目以降の呼び出しで上書きしないための判定は呼び出し側の責務)
  markFirstResponded(id: string, at: Date, tenantId: string): Promise<void>;
}
