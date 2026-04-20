// Prisma の where 条件型を参照するためにインポート
import type { Prisma } from '@/generated/prisma';
// チケットリポジトリ契約と関連型をインポート
import type {
  AssigneeWorkloadRow,
  TicketListFilter,
  TicketRepository,
} from '@/data/ports/ticket-repository';
// Prisma 行 → ドメイン型のマッパー関数群
import { toTicket, toTicketWithRefs, toUserSummary, toComment, toHistory } from './mappers';
// Prisma クライアント共通型
import type { PrismaLike } from './types';

// ドメインのフィルター条件を Prisma の WhereInput に変換するヘルパー
function buildWhere(f: TicketListFilter): Prisma.TicketWhereInput {
  // 初期値は空 (条件なし)
  const where: Prisma.TicketWhereInput = {};
  // 各フィルタが指定されていれば条件を積み上げる
  if (f.creatorId !== undefined) where.creatorId = f.creatorId;
  if (f.status !== undefined) where.status = f.status;
  if (f.priority !== undefined) where.priority = f.priority;
  if (f.categoryId !== undefined) where.categoryId = f.categoryId;
  // 担当者条件: 'unassigned' は null に読み替え
  if (f.assigneeId !== undefined) {
    where.assigneeId = f.assigneeId === 'unassigned' ? null : f.assigneeId;
  }
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
    // 最小フィールドのチケットを 1 件取得 (ドメイン型変換)
    async findById(id) {
      const row = await db.ticket.findUnique({ where: { id } });
      return row ? toTicket(row) : null;
    },

    // 関連情報付きで 1 件取得 (一覧/詳細以外のユースケース)
    async findByIdWithRefs(id) {
      const row = await db.ticket.findUnique({ where: { id }, include: REFS_INCLUDE });
      return row ? toTicketWithRefs(row) : null;
    },

    // 詳細ページ用: 関連 + コメント + 履歴 + FAQ 候補を一括取得
    async findByIdWithDetail(id) {
      const row = await db.ticket.findUnique({
        where: { id },
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

    // 一覧取得 (フィルタ/ソート/ページング)
    async list({ filter, page, sort }) {
      const rows = await db.ticket.findMany({
        where: buildWhere(filter), // ドメイン条件を Prisma 条件に変換
        orderBy: { createdAt: sort?.direction ?? 'desc' }, // 既定は降順
        skip: page.skip, // オフセット
        take: page.take, // ページサイズ
        include: REFS_INCLUDE, // 関連情報を同梱
      });
      // 取得行を TicketWithRefs に変換
      return rows.map(toTicketWithRefs);
    },

    // 件数取得 (ページング用)
    async count(filter) {
      return db.ticket.count({ where: buildWhere(filter) });
    },

    // 状態別の件数 (起票者フィルタを任意適用)
    async countByStatus({ creatorId, status }) {
      return db.ticket.count({
        where: {
          status,
          // creatorId が指定されていれば where に追加、なければ何も足さない
          ...(creatorId !== undefined ? { creatorId } : {}),
        },
      });
    },

    // SLA 期限超過 (未解決) の件数
    async countSlaOverdue(now) {
      return db.ticket.count({
        where: {
          resolutionDueAt: { lt: now }, // 期限が現在より前
          resolvedAt: null, // 未解決
          status: { notIn: ['Resolved', 'Closed'] }, // 終息状態を除外
        },
      });
    },

    // 担当者別の保持件数 (指定状態は除外)
    async workloadByAssignee({ excludeStatuses }) {
      // Prisma の groupBy で assigneeId ごとに件数を集計
      const grouped = await db.ticket.groupBy({
        by: ['assigneeId'],
        where: { status: { notIn: excludeStatuses } },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } }, // 件数の多い順
      });
      // AssigneeWorkloadRow 形式に整形して返す
      return grouped.map<AssigneeWorkloadRow>((g) => ({
        assigneeId: g.assigneeId,
        count: g._count.id,
      }));
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
          firstResponseDueAt: input.firstResponseDueAt ?? null,
          resolutionDueAt: input.resolutionDueAt ?? null,
        },
        include: REFS_INCLUDE, // 作成直後に関連情報も取得
      });
      // TicketWithRefs に変換して返す
      return toTicketWithRefs(row);
    },

    // 状態と解決日時を更新
    async updateStatus(id, status, resolvedAt) {
      await db.ticket.update({ where: { id }, data: { status, resolvedAt } });
    },

    // 優先度を更新
    async updatePriority(id, priority) {
      await db.ticket.update({ where: { id }, data: { priority } });
    },

    // 担当者を更新 (null で未アサインに戻す)
    async updateAssignee(id, assigneeId) {
      await db.ticket.update({ where: { id }, data: { assigneeId } });
    },

    // エスカレーション扱いに更新 (状態 + 理由 + 実行時刻)
    async markEscalated(id, args) {
      await db.ticket.update({
        where: { id },
        data: {
          status: 'Escalated',
          escalatedAt: args.at,
          escalationReason: args.reason,
        },
      });
    },
  };
}
