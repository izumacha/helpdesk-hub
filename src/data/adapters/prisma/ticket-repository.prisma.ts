// Prisma の where 条件型を参照するためにインポート
import type { Prisma } from '@/generated/prisma';
// 全ステータスを反復するためドメイン型をインポート
import type { TicketStatus } from '@/domain/types';
// チケットリポジトリ契約と関連型をインポート
import type {
  AssigneeWorkloadRow,
  DashboardStats,
  TicketListFilter,
  TicketRepository,
} from '@/data/ports/ticket-repository';
// Prisma 行 → ドメイン型のマッパー関数群
import { toTicket, toTicketWithRefs, toUserSummary, toComment, toHistory } from './mappers';
// Prisma クライアント共通型
import type { PrismaLike } from './types';

// ドメインのフィルター条件 + tenantId を Prisma の WhereInput に変換するヘルパー
// tenantId は **必ず AND 条件として注入** し、テナント越境参照を遮断する
function buildWhere(f: TicketListFilter, tenantId: string): Prisma.TicketWhereInput {
  // テナントスコープを最初に確定 (他フィルタはこの上に積み上げる)
  const where: Prisma.TicketWhereInput = { tenantId };
  // 各フィルタが指定されていれば条件を積み上げる
  if (f.creatorId !== undefined) where.creatorId = f.creatorId;
  if (f.status !== undefined) where.status = f.status;
  if (f.priority !== undefined) where.priority = f.priority;
  if (f.categoryId !== undefined) where.categoryId = f.categoryId;
  // 担当者条件: null は未アサインのみ、文字列は完全一致
  if (f.assigneeId !== undefined) where.assigneeId = f.assigneeId;
  // テキスト検索: title または body に contains を OR 条件で適用
  if (f.text) {
    // 大文字小文字を無視する場合は Prisma の 'insensitive' モードを指定
    const mode = f.text.caseInsensitive ? ('insensitive' as const) : undefined;
    where.OR = [
      { title: { contains: f.text.contains, mode } },
      { body: { contains: f.text.contains, mode } },
    ];
  }
  // 完成した where 条件を返す
  return where;
}

// チケット取得時に毎回使う関連 include の共通定義 (DRY 化)
const REFS_INCLUDE = {
  creator: { select: { id: true, name: true } },
  assignee: { select: { id: true, name: true } },
  category: { select: { id: true, name: true } },
} as const;

// Prisma クライアントを使ったチケットリポジトリを生成する関数
export function makeTicketRepo(db: PrismaLike): TicketRepository {
  return {
    // 最小フィールドのチケットを 1 件取得 (tenantId スコープ、他テナントの ID なら null)
    async findById(id, tenantId) {
      // findFirst で複合条件 (id + tenantId) の AND 一致を検索
      const row = await db.ticket.findFirst({ where: { id, tenantId } });
      return row ? toTicket(row) : null;
    },

    // 関連情報付きで 1 件取得 (tenantId スコープ)
    async findByIdWithRefs(id, tenantId) {
      const row = await db.ticket.findFirst({
        where: { id, tenantId },
        include: REFS_INCLUDE,
      });
      return row ? toTicketWithRefs(row) : null;
    },

    // 詳細ページ用: 関連 + コメント + 履歴 + FAQ 候補を一括取得 (tenantId スコープ)
    async findByIdWithDetail(id, tenantId) {
      const row = await db.ticket.findFirst({
        where: { id, tenantId },
        include: {
          ...REFS_INCLUDE, // 起票者/担当者/カテゴリ
          // コメントは古い順に、投稿者名を JOIN
          comments: {
            orderBy: { createdAt: 'asc' },
            include: { author: { select: { id: true, name: true } } },
          },
          // 履歴は新しい順に、変更者名を JOIN
          histories: {
            orderBy: { createdAt: 'desc' },
            include: { changedBy: { select: { id: true, name: true } } },
          },
          // 紐づく FAQ 候補 (存在すれば ID のみ)
          faqCandidate: { select: { id: true } },
        },
      });
      // チケットが存在しなければ null を返す
      if (!row) return null;
      // 取得結果を TicketDetail 形式に整形
      return {
        ...toTicketWithRefs(row),
        comments: row.comments.map((c) => ({
          ...toComment(c),
          author: toUserSummary(c.author),
        })),
        histories: row.histories.map((h) => ({
          ...toHistory(h),
          changedBy: toUserSummary(h.changedBy),
        })),
        faqCandidate: row.faqCandidate ? { id: row.faqCandidate.id } : null,
      };
    },

    // 一覧取得 (フィルタ/ソート/ページング、tenantId スコープ)
    async list({ filter, page, sort, tenantId }) {
      const rows = await db.ticket.findMany({
        where: buildWhere(filter, tenantId), // tenantId を必ず注入
        orderBy: { createdAt: sort?.direction ?? 'desc' }, // 既定は降順
        skip: page.skip, // オフセット
        take: page.take, // ページサイズ
        include: REFS_INCLUDE, // 関連情報を同梱
      });
      // 取得行を TicketWithRefs に変換
      return rows.map(toTicketWithRefs);
    },

    // 件数取得 (tenantId スコープ)
    async count(filter, tenantId) {
      return db.ticket.count({ where: buildWhere(filter, tenantId) });
    },

    // ダッシュボード一括取得 (status 別件数 / SLA 超過 / 担当者別ワークロード、tenantId スコープ)
    async dashboardStats({ creatorId, now, excludeStatusesForWorkload, tenantId }) {
      // ベース where: テナントを必ず固定し、起票者フィルタは byStatus 用にだけ適用
      const baseWhere: Prisma.TicketWhereInput = { tenantId };
      // 起票者フィルタを追加した where (byStatus 専用)
      const byStatusWhere: Prisma.TicketWhereInput =
        creatorId !== undefined ? { ...baseWhere, creatorId } : baseWhere;
      // 3 種類のクエリを並列実行 (1 ラウンドトリップ分の待ち時間で完了)
      const [grouped, slaOverdue, workload] = await Promise.all([
        // status 別件数を 1 回の groupBy で取得 (byStatusWhere = テナント + 起票者)
        db.ticket.groupBy({
          by: ['status'],
          where: byStatusWhere,
          _count: { id: true },
        }),
        // SLA 超過件数 (テナント内かつ未解決かつ期限切れ)
        db.ticket.count({
          where: {
            ...baseWhere,
            resolutionDueAt: { lt: now },
            resolvedAt: null,
            status: { notIn: ['Resolved', 'Closed'] },
          },
        }),
        // 担当者別の保持件数 (テナント内、指定状態は除外)
        db.ticket.groupBy({
          by: ['assigneeId'],
          where: { ...baseWhere, status: { notIn: excludeStatusesForWorkload } },
          _count: { id: true },
          orderBy: { _count: { id: 'desc' } },
        }),
      ]);
      // 全 7 状態を 0 で初期化してから groupBy 結果で上書き (該当なしも 0 として返す)
      const byStatus: Record<TicketStatus, number> = {
        New: 0,
        Open: 0,
        WaitingForUser: 0,
        InProgress: 0,
        Escalated: 0,
        Resolved: 0,
        Closed: 0,
      };
      for (const row of grouped) {
        byStatus[row.status as TicketStatus] = row._count.id;
      }
      // DashboardStats 形式で返却
      const result: DashboardStats = {
        byStatus,
        slaOverdue,
        workload: workload.map<AssigneeWorkloadRow>((g) => ({
          assigneeId: g.assigneeId,
          count: g._count.id,
        })),
      };
      return result;
    },

    // 新規チケットを作成 (関連情報付きで返す)
    async create(input) {
      const row = await db.ticket.create({
        data: {
          title: input.title,
          body: input.body,
          priority: input.priority,
          categoryId: input.categoryId,
          creatorId: input.creatorId,
          tenantId: input.tenantId, // テナント所属を必ず保存
          firstResponseDueAt: input.firstResponseDueAt ?? null,
          resolutionDueAt: input.resolutionDueAt ?? null,
        },
        include: REFS_INCLUDE, // 作成直後に関連情報も取得
      });
      // TicketWithRefs に変換して返す
      return toTicketWithRefs(row);
    },

    // 状態と解決日時を更新 (tenantId スコープ。updateMany で id+tenantId AND 一致のみ更新)
    async updateStatus(id, status, resolvedAt, tenantId) {
      await db.ticket.updateMany({ where: { id, tenantId }, data: { status, resolvedAt } });
    },

    // 優先度を更新 (tenantId スコープ)
    async updatePriority(id, priority, tenantId) {
      await db.ticket.updateMany({ where: { id, tenantId }, data: { priority } });
    },

    // 担当者を更新 (tenantId スコープ、null で未アサインに戻す)
    async updateAssignee(id, assigneeId, tenantId) {
      await db.ticket.updateMany({ where: { id, tenantId }, data: { assigneeId } });
    },

    // エスカレーション扱いに更新 (tenantId スコープ)
    async markEscalated(id, args, tenantId) {
      await db.ticket.updateMany({
        where: { id, tenantId },
        data: {
          status: 'Escalated',
          escalatedAt: args.at,
          escalationReason: args.reason,
        },
      });
    },
  };
}
