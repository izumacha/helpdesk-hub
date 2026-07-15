// ドメイン型 (チケット関連) をインポート
import type {
  Ticket,
  TicketComment,
  TicketHistory,
  TicketStatus,
  TicketWithRefs,
  UserSummary,
} from '@/domain/types';
// チケットリポジトリ契約と関連型をインポート
import type {
  AssigneeWorkloadRow,
  DashboardStats,
  QualityMetrics,
  TicketDetail,
  TicketListFilter,
  TicketRepository,
} from '@/data/ports/ticket-repository';
// メモリストアと ID 生成ヘルパーをインポート
import { nextId, type Store } from './store';

// ID からユーザー概要を作るヘルパー (見つからなければ null)
function userSummary(store: Store, id: string | null): UserSummary | null {
  if (!id) return null; // null なら何もしない
  const u = store.users.get(id); // Map から取得
  return u ? { id: u.id, name: u.name } : null; // 見つかれば要約に変換
}

// チケットに起票者/担当者/カテゴリを結合して TicketWithRefs を作る関数
function attachRefs(ticket: Ticket, store: Store): TicketWithRefs {
  const creator = userSummary(store, ticket.creatorId); // 起票者を取得
  // 起票者は必須。欠損していれば整合性エラーとして throw
  if (!creator) {
    throw new Error(`memory adapter: creator ${ticket.creatorId} missing for ticket ${ticket.id}`);
  }
  // カテゴリ ID があれば引き当て (無ければ null)
  const category = ticket.categoryId ? (store.categories.get(ticket.categoryId) ?? null) : null;
  // 拠点 ID があれば引き当て (無ければ null。Phase 4 多拠点)
  const location = ticket.locationId ? (store.locations.get(ticket.locationId) ?? null) : null;
  // 全フィールドをそのまま引き継ぎつつ、関連情報を上書きで付加する
  return {
    ...ticket,
    creator,
    assignee: userSummary(store, ticket.assigneeId),
    category: category ? { id: category.id, name: category.name } : null,
    location: location ? { id: location.id, name: location.name } : null,
  };
}

// 指定フィルタ条件に一致するかを判定するヘルパー (tenantId は別途必須でチェック)
function matchesFilter(t: Ticket, filter: TicketListFilter, tenantId: string): boolean {
  // テナントスコープを最優先で確認 (他テナントの行は問答無用で除外)
  if (t.tenantId !== tenantId) return false;
  // 起票者フィルター: 指定があり一致しなければ除外
  if (filter.creatorId !== undefined && t.creatorId !== filter.creatorId) return false;
  // 状態フィルター (単一)
  if (filter.status !== undefined && t.status !== filter.status) return false;
  // 状態フィルター (複数)。Lite「自分の未対応」など Open OR InProgress に使う
  if (filter.statusIn && filter.statusIn.length > 0 && !filter.statusIn.includes(t.status))
    return false;
  // 優先度フィルター
  if (filter.priority !== undefined && t.priority !== filter.priority) return false;
  // カテゴリフィルター
  if (filter.categoryId !== undefined && t.categoryId !== filter.categoryId) return false;
  // 担当者フィルター (undefined は無指定、null は未アサインのみ)
  if (filter.assigneeId !== undefined && t.assigneeId !== filter.assigneeId) return false;
  // 拠点フィルター (undefined は無指定、null は拠点未設定のみ、文字列は完全一致)
  if (filter.locationId !== undefined && t.locationId !== filter.locationId) return false;
  // 作成日時フィルター: この日時以降に作成されたチケットのみ (月間件数カウント用)
  if (filter.createdAfter !== undefined && t.createdAt < filter.createdAfter) return false;
  // 期限切れフィルター: 期限あり / 期限超過 / 未解決 / 終息状態でない
  if (filter.overdue) {
    if (!t.resolutionDueAt) return false;
    if (t.resolutionDueAt >= filter.overdue.now) return false;
    // != null は null と undefined の両方を弾く (型が将来 Date | null | undefined に広がっても安全)
    if (t.resolvedAt != null) return false;
    if (t.status === 'Resolved' || t.status === 'Closed') return false;
  }
  // テキスト検索フィルター (title または body の部分一致)
  if (filter.text) {
    // 大文字小文字を無視する場合は両方小文字化する
    const needle = filter.text.caseInsensitive
      ? filter.text.contains.toLowerCase()
      : filter.text.contains;
    // 判定関数 (文字列 s に needle が含まれるか)
    const match = (s: string) => {
      const haystack = filter.text!.caseInsensitive ? s.toLowerCase() : s;
      return haystack.includes(needle);
    };
    // title にも body にも無ければ除外
    if (!match(t.title) && !match(t.body)) return false;
  }
  // 全条件を満たした
  return true;
}

// メモリストアを使ったチケットリポジトリを生成する関数
export function makeTicketRepo(store: Store): TicketRepository {
  return {
    // ID + tenantId で最小フィールドのチケットを 1 件取得 (複製して返す)
    async findById(id, tenantId) {
      const t = store.tickets.get(id);
      // テナント不一致なら null (クロステナント参照を遮断)
      if (!t || t.tenantId !== tenantId) return null;
      return { ...t };
    },

    // ID + tenantId で起票者/担当者/カテゴリを結合したチケットを取得
    async findByIdWithRefs(id, tenantId) {
      const t = store.tickets.get(id);
      if (!t || t.tenantId !== tenantId) return null;
      return attachRefs(t, store);
    },

    // 詳細ページ用に、コメント/履歴/FAQ 候補/添付を含むチケットを取得 (tenantId スコープ)
    async findByIdWithDetail(id, tenantId) {
      const t = store.tickets.get(id); // 本体取得
      if (!t || t.tenantId !== tenantId) return null; // テナント不一致は null
      const withRefs = attachRefs(t, store); // 関連情報を結合

      // 対象チケットの添付一覧を作成日時の昇順に整形しておく (コメントごとの絞り込みでも再利用)
      const allAttachments = [...store.attachments.values()]
        .filter((a) => a.ticketId === id && a.tenantId === tenantId)
        .sort((a, b) => +a.createdAt - +b.createdAt);

      // Attachment ドメイン型から AttachmentSummary (表示用最小情報) を取り出すヘルパー
      const toSummary = (a: (typeof allAttachments)[number]) => ({
        id: a.id,
        mimeType: a.mimeType,
        size: a.size,
        originalName: a.originalName,
        createdAt: a.createdAt,
      });

      // 対象チケットのコメントを古い順に整形 (各コメントの添付も同時に集約)
      const comments = [...store.comments.values()]
        .filter((c) => c.ticketId === id) // 対象チケットのみ
        .sort((a, b) => +a.createdAt - +b.createdAt) // 時系列 (古い→新しい)
        .map((c: TicketComment) => {
          const author = userSummary(store, c.authorId); // 書き込み者
          if (!author) throw new Error(`memory adapter: author ${c.authorId} missing`);
          // このコメントに紐づく添付だけ抽出してサマリ化する
          const attachments = allAttachments.filter((a) => a.commentId === c.id).map(toSummary);
          return { ...c, author, attachments };
        });

      // 対象チケットの履歴を新しい順に整形
      const histories = [...store.histories.values()]
        .filter((h) => h.ticketId === id)
        .sort((a, b) => +b.createdAt - +a.createdAt)
        .map((h: TicketHistory) => {
          const changedBy = userSummary(store, h.changedById); // 変更者
          if (!changedBy) throw new Error(`memory adapter: changedBy ${h.changedById} missing`);
          return { ...h, changedBy };
        });

      // 紐づく FAQ 候補を 1 件だけ検索 (なければ null)
      const faqRow = [...store.faq.values()].find((f) => f.ticketId === id) ?? null;

      // チケット本体に直接添付された画像のみ (commentId が null のもの)
      const ticketAttachments = allAttachments.filter((a) => a.commentId === null).map(toSummary);

      // 詳細オブジェクトを組み立てて返す
      const detail: TicketDetail = {
        ...withRefs,
        comments,
        histories,
        faqCandidate: faqRow ? { id: faqRow.id } : null,
        attachments: ticketAttachments,
      };
      return detail;
    },

    // 一覧取得 (フィルタ/ソート/ページング、tenantId スコープ)
    async list({ filter, page, sort, tenantId }) {
      // フィルター適用 (matchesFilter 内で tenantId も判定)
      let rows = [...store.tickets.values()].filter((t) => matchesFilter(t, filter, tenantId));
      // ソート方向を決定 (既定は降順)
      const direction = sort?.direction ?? 'desc';
      // createdAt で並び替え
      rows.sort((a, b) =>
        direction === 'asc' ? +a.createdAt - +b.createdAt : +b.createdAt - +a.createdAt,
      );
      // ページング適用
      rows = rows.slice(page.skip, page.skip + page.take);
      // 各行に関連情報を結合して返す
      return rows.map((t) => attachRefs(t, store));
    },

    // 条件に一致する件数をカウント (tenantId スコープ)
    async count(filter, tenantId) {
      let n = 0; // カウンタ
      // 全チケットを走査し、条件一致を加算
      for (const t of store.tickets.values()) {
        if (matchesFilter(t, filter, tenantId)) n += 1;
      }
      // 件数を返す
      return n;
    },

    // ダッシュボード一括取得 (status 別件数 / SLA 超過 / 担当者別ワークロード、tenantId スコープ)
    async dashboardStats({ creatorId, now, excludeStatusesForWorkload, tenantId, locationId }) {
      // 状態別件数を 0 で初期化 (該当なしも 0 として返す)
      const byStatus: Record<TicketStatus, number> = {
        New: 0,
        Open: 0,
        WaitingForUser: 0,
        InProgress: 0,
        Escalated: 0,
        Resolved: 0,
        Closed: 0,
      };
      // SLA 超過件数のカウンタ
      let slaOverdue = 0;
      // 担当者 ID ごとの保持件数 (ワークロード集計用)
      const workloadCounts = new Map<string | null, number>();
      // 全チケットを 1 度だけ走査して 3 指標を同時に集計
      for (const t of store.tickets.values()) {
        // 当該テナント以外は集計対象外
        if (t.tenantId !== tenantId) continue;
        // locationId 指定時は当該拠点以外を集計対象外にする (未指定なら全拠点対象)
        if (locationId !== undefined && t.locationId !== locationId) continue;
        // byStatus: 起票者フィルタ (creatorId 指定時のみ) を満たす場合に集計
        if (creatorId === undefined || t.creatorId === creatorId) {
          byStatus[t.status] += 1;
        }
        // slaOverdue: 期限あり / 期限切れ / 未解決 / 終息状態でない
        if (
          t.resolutionDueAt &&
          t.resolutionDueAt < now &&
          t.resolvedAt == null &&
          t.status !== 'Resolved' &&
          t.status !== 'Closed'
        ) {
          slaOverdue += 1;
        }
        // workload: 除外状態でなければ担当者ごとに加算
        if (!excludeStatusesForWorkload.includes(t.status)) {
          workloadCounts.set(t.assigneeId, (workloadCounts.get(t.assigneeId) ?? 0) + 1);
        }
      }
      // ワークロード Map を配列に変換し件数降順で並べる
      const workload: AssigneeWorkloadRow[] = [...workloadCounts.entries()]
        .map(([assigneeId, count]) => ({ assigneeId, count }))
        .sort((a, b) => b.count - a.count);
      // DashboardStats 形式で返却
      const result: DashboardStats = { byStatus, slaOverdue, workload };
      return result;
    },

    // 新規チケットを作成 (初期状態は 'New')
    async create(input) {
      // /code-review ultra 指摘対応 (2026-07-13): CSV インポートは resolvedAt/firstRespondedAt が
      // createdAt より前にならないよう、同じ取り込み時刻を明示的に渡す (Prisma アダプタと同じ方針)。
      // 未指定なら通常どおりこの呼び出し時点の時刻を作成日時にする
      const now = input.createdAt ?? new Date(); // 作成時刻
      // 新規チケット行を組み立て
      const ticket: Ticket = {
        id: nextId(store, 'tkt'), // 'tkt_...' 形式の一意 ID
        title: input.title,
        body: input.body,
        status: input.status ?? 'New', // 初期ステータス: 指定があればそれ、未指定なら New でスタート
        priority: input.priority,
        createdAt: now,
        updatedAt: now,
        firstResponseDueAt: input.firstResponseDueAt ?? null,
        resolutionDueAt: input.resolutionDueAt ?? null,
        // フォローアップ (2026-07-13): CSV インポートで初期状態以外を指定時の初回応答日時 (未指定なら null)
        firstRespondedAt: input.firstRespondedAt ?? null,
        // §3.1 フォローアップ: CSV インポートで完了系ステータス指定時の解決日時 (未指定なら null)
        resolvedAt: input.resolvedAt ?? null,
        escalatedAt: null,
        escalationReason: null,
        creatorId: input.creatorId,
        // フォローアップ (2026-07-13): CSV インポートで担当者名を解決した ID (未指定なら未アサイン)
        assigneeId: input.assigneeId ?? null,
        categoryId: input.categoryId,
        locationId: input.locationId ?? null, // 拠点 ID (Phase 4 多拠点。未指定なら null)
        tenantId: input.tenantId, // 所属テナントを必ず保存
      };
      // ストアに登録
      store.tickets.set(ticket.id, ticket);
      // 関連情報を付けて返却
      return attachRefs(ticket, store);
    },

    // 状態を更新 (tenantId スコープ。期待する現在状態 transition.from が一致するときだけ更新し、
    // 一致しなければ false を返す。Prisma アダプタと同じ契約 (check-then-act 競合の防止。
    // フォローアップ 2026-07-15 #2)
    async updateStatus(id, transition, resolvedAt, tenantId) {
      const t = store.tickets.get(id); // 対象取得
      // 不在 or テナント不一致は何もしない (Prisma の updateMany と同じ挙動)
      if (!t || t.tenantId !== tenantId) return false;
      // 期待状態と不一致 (競合) なら更新しない
      if (t.status !== transition.from) return false;
      // 新しい状態/解決日時/更新時刻で置き換え
      store.tickets.set(id, { ...t, status: transition.to, resolvedAt, updatedAt: new Date() });
      return true;
    },

    // 優先度と期限 (dueDates) を更新 (tenantId スコープ。フォローアップ 2026-07-15)
    async updatePriority(id, priority, dueDates, tenantId) {
      const t = store.tickets.get(id);
      if (!t || t.tenantId !== tenantId) return;
      store.tickets.set(id, {
        ...t,
        priority,
        firstResponseDueAt: dueDates.firstResponseDueAt,
        resolutionDueAt: dueDates.resolutionDueAt,
        updatedAt: new Date(),
      });
    },

    // 担当者を更新 (tenantId スコープ。null で未アサインに戻す)
    async updateAssignee(id, assigneeId, tenantId) {
      const t = store.tickets.get(id);
      if (!t || t.tenantId !== tenantId) return;
      store.tickets.set(id, { ...t, assigneeId, updatedAt: new Date() });
    },

    // カテゴリを更新 (tenantId スコープ。null で未分類に戻す。フォローアップ 2026-07-14 #4)
    async updateCategory(id, categoryId, tenantId) {
      const t = store.tickets.get(id);
      if (!t || t.tenantId !== tenantId) return;
      store.tickets.set(id, { ...t, categoryId, updatedAt: new Date() });
    },

    // 拠点を更新 (tenantId スコープ。null で未指定に戻す。フォローアップ 2026-07-14 #4)
    async updateLocation(id, locationId, tenantId) {
      const t = store.tickets.get(id);
      if (!t || t.tenantId !== tenantId) return;
      store.tickets.set(id, { ...t, locationId, updatedAt: new Date() });
    },

    // エスカレーション扱いに更新 (tenantId スコープ)。期待する現在状態 expectedStatus が一致する
    // ときだけ更新し、一致しなければ false を返す (Prisma アダプタと同じ契約。フォローアップ 2026-07-15 #2)
    async markEscalated(id, args, expectedStatus, tenantId) {
      const t = store.tickets.get(id);
      if (!t || t.tenantId !== tenantId) return false;
      if (t.status !== expectedStatus) return false;
      store.tickets.set(id, {
        ...t,
        status: 'Escalated',
        escalatedAt: args.at,
        escalationReason: args.reason,
        updatedAt: new Date(),
      });
      return true;
    },

    // 初回応答日時を記録する (tenantId スコープ)
    async markFirstResponded(id, at, tenantId) {
      const t = store.tickets.get(id);
      if (!t || t.tenantId !== tenantId) return;
      // 既に初回応答済みなら上書きしない (Prisma アダプタの where firstRespondedAt: null と
      // 同じ規約に揃える。呼び出し側のスナップショット判定が古くても、ここで最終防衛する)
      if (t.firstRespondedAt) return;
      store.tickets.set(id, { ...t, firstRespondedAt: at, updatedAt: new Date() });
    },

    // 品質メトリクスを算出して返す (tenantId スコープ。since 指定時はその日時以降作成分のみ)
    async qualityMetrics({ tenantId, since, locationId }) {
      // テナントスコープ + since 条件 + locationId 条件 (指定時のみ) でチケットを絞り込む
      const allTickets = [...store.tickets.values()].filter(
        (t) =>
          t.tenantId === tenantId &&
          (!since || t.createdAt >= since) &&
          (locationId === undefined || t.locationId === locationId),
      );

      // 初回応答済みチケット (firstRespondedAt が設定されているもの) を抽出する
      const responded = allTickets.filter((t) => t.firstRespondedAt != null);
      // 初回応答時間 (ms) の平均を計算する (対象なしは null)
      const avgFirstResponseMs =
        responded.length > 0
          ? responded.reduce(
              (sum, t) => sum + (t.firstRespondedAt!.getTime() - t.createdAt.getTime()),
              0,
            ) / responded.length
          : null;

      // 解決済みチケット (resolvedAt が設定されているもの) を抽出する
      const resolved = allTickets.filter((t) => t.resolvedAt != null);
      // 解決時間 (ms) の平均を計算する (対象なしは null)
      const avgResolutionMs =
        resolved.length > 0
          ? resolved.reduce(
              (sum, t) => sum + (t.resolvedAt!.getTime() - t.createdAt.getTime()),
              0,
            ) / resolved.length
          : null;

      // 対象チケットの ID セットを作っておく (履歴検索の絞り込みに使う)
      const ticketIds = new Set(allTickets.map((t) => t.id));
      // 再オープン履歴を持つチケット ID を収集する
      // (field='status', newValue='Open', oldValue='Resolved' or 'Closed' の履歴が 1 件以上存在するもの)
      const reopenedIds = new Set(
        [...store.histories.values()]
          .filter(
            (h) =>
              ticketIds.has(h.ticketId) &&
              h.field === 'status' &&
              h.newValue === 'Open' &&
              (h.oldValue === 'Resolved' || h.oldValue === 'Closed'),
          )
          .map((h) => h.ticketId),
      );
      // 再オープン率 = 再オープン済みチケット数 / 全対象チケット数 (対象なしは null)
      const reopenRate = allTickets.length > 0 ? reopenedIds.size / allTickets.length : null;

      // QualityMetrics 型に準拠して返す
      return {
        avgFirstResponseMs,
        avgResolutionMs,
        reopenRate,
        resolvedCount: resolved.length,
        // 再オープン率の分母は解決済み件数ではなく全対象チケット件数
        totalCount: allTickets.length,
      } satisfies QualityMetrics;
    },
  };
}
