// Prisma の where 条件型を参照するためにインポート
import type { Prisma } from '@/generated/prisma';
// 全ステータスを反復するためドメイン型をインポート
import type { TicketStatus } from '@/domain/types';
// チケットリポジトリ契約と関連型をインポート
import type {
  AssigneeWorkloadRow,
  DashboardStats,
  QualityMetrics,
  TicketListFilter,
  TicketRepository,
} from '@/data/ports/ticket-repository';
// Prisma 行 → ドメイン型のマッパー関数群
import {
  toAttachmentSummary,
  toComment,
  toHistory,
  toTicket,
  toTicketWithRefs,
  toUserSummary,
} from './mappers';
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
  // 複数状態の OR 絞り込み (Lite モードの「自分の未対応」で Open/InProgress を一度に取るため)
  if (f.statusIn && f.statusIn.length > 0) where.status = { in: f.statusIn };
  if (f.priority !== undefined) where.priority = f.priority;
  if (f.categoryId !== undefined) where.categoryId = f.categoryId;
  // 担当者条件: null は未アサインのみ、文字列は完全一致
  if (f.assigneeId !== undefined) where.assigneeId = f.assigneeId;
  // 拠点条件: null は拠点未設定のみ、文字列は完全一致 (Phase 4 多拠点)
  if (f.locationId !== undefined) where.locationId = f.locationId;
  // 作成日時フィルター: この日時以降に作成されたチケットのみ (月間件数カウント用)
  if (f.createdAfter !== undefined) where.createdAt = { gte: f.createdAfter };
  // 期限切れフィルタ (Lite モードの「期限切れ」タブで使用)
  // - resolutionDueAt < now (期限を過ぎている)
  // - resolvedAt IS NULL (まだ解決していない)
  // - status が Resolved/Closed でない (業務上の終息状態は除外)
  if (f.overdue) {
    where.resolutionDueAt = { lt: f.overdue.now };
    where.resolvedAt = null;
    where.status = { notIn: ['Resolved', 'Closed'] };
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
  location: { select: { id: true, name: true } }, // 拠点 (Phase 4 多拠点)
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

    // 詳細ページ用: 関連 + コメント + 履歴 + FAQ 候補 + 添付を一括取得 (tenantId スコープ)
    async findByIdWithDetail(id, tenantId) {
      const row = await db.ticket.findFirst({
        where: { id, tenantId },
        include: {
          ...REFS_INCLUDE, // 起票者/担当者/カテゴリ
          // コメントは古い順に、投稿者名と添付一覧を JOIN
          comments: {
            orderBy: { createdAt: 'asc' },
            include: {
              author: { select: { id: true, name: true } },
              // 各コメントに紐づく添付 (古い順)
              attachments: { orderBy: { createdAt: 'asc' } },
            },
          },
          // 履歴は新しい順に、変更者名を JOIN
          histories: {
            orderBy: { createdAt: 'desc' },
            include: { changedBy: { select: { id: true, name: true } } },
          },
          // 紐づく FAQ 候補 (存在すれば ID のみ)
          faqCandidate: { select: { id: true } },
          // チケット本体に直接添付された画像 (古い順) — commentId IS NULL のものだけに絞る
          attachments: {
            where: { commentId: null },
            orderBy: { createdAt: 'asc' },
          },
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
          attachments: c.attachments.map(toAttachmentSummary), // 各コメントの添付一覧
        })),
        histories: row.histories.map((h) => ({
          ...toHistory(h),
          changedBy: toUserSummary(h.changedBy),
        })),
        faqCandidate: row.faqCandidate ? { id: row.faqCandidate.id } : null,
        attachments: row.attachments.map(toAttachmentSummary), // チケット直接添付の一覧
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
          // 初期ステータス: 指定があればそれを使い、未指定なら undefined を渡して Prisma 既定(New)に任せる
          status: input.status ?? undefined,
          priority: input.priority,
          categoryId: input.categoryId,
          locationId: input.locationId ?? null, // 拠点 ID (Phase 4 多拠点。未指定なら null)
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

    // 初回応答日時を記録する (tenantId スコープ)
    async markFirstResponded(id, at, tenantId) {
      // where に firstRespondedAt: null も含めることで、既に初回応答済みの行には書き込まない
      // ようにする (呼び出し側の !ticket.firstRespondedAt 判定はトランザクション開始前に取得した
      // スナップショットに基づくため、ほぼ同時に届いた 2 件目以降のコメントが最初の応答時刻を
      // 後から上書きしてしまう競合を防ぐ。2 件目以降は対象行が 0 件になり安全な no-op になる)
      await db.ticket.updateMany({
        where: { id, tenantId, firstRespondedAt: null },
        data: { firstRespondedAt: at },
      });
    },

    // 品質メトリクスを算出して返す (issue-backlog #25)
    // 平均初回応答時間・平均解決時間・再オープン率を 3 本の SQL で並列取得する。
    // Prisma ORM では日時間隔の AVG を直接計算できないため $queryRaw で PostgreSQL の
    // EXTRACT(EPOCH FROM ...) 関数を使う。
    async qualityMetrics({ tenantId, since }) {
      // 期間フィルタの境界値。since が指定されない場合は全期間が対象
      // (Prisma は tagged template の型安全性を保持するため引数型に null を使う)
      const sinceValue: Date | null = since ?? null;

      // 3 本の SQL クエリを並列実行する (直列だと合計レイテンシが 3 倍になるため)。
      // クエリ間に依存がないため Promise.all で安全に並列化できる。
      const [responseRows, resolutionRows, reopenRows] = await Promise.all([
        // ── クエリ 1: 平均初回応答時間 ──
        // firstRespondedAt - createdAt の平均をミリ秒で返す。
        // firstRespondedAt が null のチケット (未応答) は除外する。
        // EXTRACT(EPOCH ...) は秒単位なので × 1000 でミリ秒に変換する。
        db.$queryRaw<[{ avg_ms: number | null }]>`
          SELECT AVG(
            EXTRACT(EPOCH FROM ("firstRespondedAt" - "createdAt")) * 1000
          ) AS avg_ms
          FROM "Ticket"
          WHERE "tenantId" = ${tenantId}
            AND "firstRespondedAt" IS NOT NULL
            AND (${sinceValue}::timestamptz IS NULL OR "createdAt" >= ${sinceValue}::timestamptz)
        `,
        // ── クエリ 2: 平均解決時間 ──
        // resolvedAt - createdAt の平均をミリ秒で返す。
        // resolvedAt が null のチケット (未解決) は除外する。
        db.$queryRaw<[{ avg_ms: number | null; cnt: bigint }]>`
          SELECT
            AVG(EXTRACT(EPOCH FROM ("resolvedAt" - "createdAt")) * 1000) AS avg_ms,
            COUNT(*) AS cnt
          FROM "Ticket"
          WHERE "tenantId" = ${tenantId}
            AND "resolvedAt" IS NOT NULL
            AND (${sinceValue}::timestamptz IS NULL OR "createdAt" >= ${sinceValue}::timestamptz)
        `,
        // ── クエリ 3: 再オープン率 ──
        // 全チケット数のうち、「Resolved または Closed → Open への遷移履歴」を持つ
        // チケットの割合を返す。
        // TicketHistory.field = 'status' かつ newValue = 'Open' かつ
        // oldValue IN ('Resolved', 'Closed') の行を持つ ticket を「再オープン済み」とみなす。
        db.$queryRaw<[{ total: bigint; reopened: bigint }]>`
          SELECT
            COUNT(DISTINCT t.id) AS total,
            COUNT(DISTINCT th."ticketId") AS reopened
          FROM "Ticket" t
          LEFT JOIN "TicketHistory" th
            ON th."ticketId" = t.id
            AND th.field = 'status'
            AND th."newValue" = 'Open'
            AND th."oldValue" IN ('Resolved', 'Closed')
          WHERE t."tenantId" = ${tenantId}
            AND (${sinceValue}::timestamptz IS NULL OR t."createdAt" >= ${sinceValue}::timestamptz)
        `,
      ]);

      // 平均初回応答時間: Prisma は $queryRaw の数値を Decimal や number で返すことがある
      // Number() で確実に JS の number に変換し、NaN は null に正規化する
      const rawAvgFirstResponse = responseRows[0]?.avg_ms;
      const avgFirstResponseMs =
        rawAvgFirstResponse != null && !Number.isNaN(Number(rawAvgFirstResponse))
          ? Number(rawAvgFirstResponse)
          : null;

      // 平均解決時間: 同様に number に変換する
      const rawAvgResolution = resolutionRows[0]?.avg_ms;
      const avgResolutionMs =
        rawAvgResolution != null && !Number.isNaN(Number(rawAvgResolution))
          ? Number(rawAvgResolution)
          : null;

      // 解決済みチケット件数: BigInt → number に変換 (DB の COUNT は BigInt で返る)
      const resolvedCount = Number(resolutionRows[0]?.cnt ?? 0);

      // 再オープン率: total が 0 のときは null (0 除算を避ける)
      const total = Number(reopenRows[0]?.total ?? 0);
      const reopened = Number(reopenRows[0]?.reopened ?? 0);
      const reopenRate = total > 0 ? reopened / total : null;

      // 品質メトリクス結果を返す
      return {
        avgFirstResponseMs,
        avgResolutionMs,
        reopenRate,
        resolvedCount,
        // 再オープン率の分母は全チケット件数 (resolvedCount ではない)
        totalCount: total,
      } satisfies QualityMetrics;
    },
  };
}
