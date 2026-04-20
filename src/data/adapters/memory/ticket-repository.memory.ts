// ドメイン型 (チケット関連) をインポート
import type {
  Ticket,
  TicketComment,
  TicketHistory,
  TicketWithRefs,
  UserSummary,
} from '@/domain/types';
// チケットリポジトリ契約と関連型をインポート
import type {
  AssigneeWorkloadRow,
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
  // 全フィールドをそのまま引き継ぎつつ、関連情報を上書きで付加する
  return {
    ...ticket,
    creator,
    assignee: userSummary(store, ticket.assigneeId),
    category: category ? { id: category.id, name: category.name } : null,
  };
}

// 指定フィルタ条件に一致するかを判定するヘルパー
function matchesFilter(t: Ticket, filter: TicketListFilter): boolean {
  // 起票者フィルター: 指定があり一致しなければ除外
  if (filter.creatorId !== undefined && t.creatorId !== filter.creatorId) return false;
  // 状態フィルター
  if (filter.status !== undefined && t.status !== filter.status) return false;
  // 優先度フィルター
  if (filter.priority !== undefined && t.priority !== filter.priority) return false;
  // カテゴリフィルター
  if (filter.categoryId !== undefined && t.categoryId !== filter.categoryId) return false;
  // 担当者フィルター (undefined は無指定、'unassigned' は未アサインを意味する)
  if (filter.assigneeId !== undefined) {
    const target = filter.assigneeId === 'unassigned' ? null : filter.assigneeId;
    if (t.assigneeId !== target) return false;
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
    // ID で最小フィールドのチケットを 1 件取得 (複製して返す)
    async findById(id) {
      const t = store.tickets.get(id);
      return t ? { ...t } : null;
    },

    // ID で起票者/担当者/カテゴリを結合したチケットを取得
    async findByIdWithRefs(id) {
      const t = store.tickets.get(id);
      return t ? attachRefs(t, store) : null;
    },

    // 詳細ページ用に、コメント/履歴/FAQ 候補を含むチケットを取得
    async findByIdWithDetail(id) {
      const t = store.tickets.get(id); // 本体取得
      if (!t) return null; // 無ければ null
      const withRefs = attachRefs(t, store); // 関連情報を結合

      // 対象チケットのコメントを古い順に整形
      const comments = [...store.comments.values()]
        .filter((c) => c.ticketId === id) // 対象チケットのみ
        .sort((a, b) => +a.createdAt - +b.createdAt) // 時系列 (古い→新しい)
        .map((c: TicketComment) => {
          const author = userSummary(store, c.authorId); // 書き込み者
          if (!author) throw new Error(`memory adapter: author ${c.authorId} missing`);
          return { ...c, author };
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

      // 詳細オブジェクトを組み立てて返す
      const detail: TicketDetail = {
        ...withRefs,
        comments,
        histories,
        faqCandidate: faqRow ? { id: faqRow.id } : null,
      };
      return detail;
    },

    // 一覧取得 (フィルタ/ソート/ページング)
    async list({ filter, page, sort }) {
      // フィルター適用
      let rows = [...store.tickets.values()].filter((t) => matchesFilter(t, filter));
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

    // 条件に一致する件数をカウント
    async count(filter) {
      let n = 0; // カウンタ
      // 全チケットを走査し、条件一致を加算
      for (const t of store.tickets.values()) {
        if (matchesFilter(t, filter)) n += 1;
      }
      // 件数を返す
      return n;
    },

    // 特定状態のチケット件数を取得 (起票者フィルタ付き)
    async countByStatus({ creatorId, status }) {
      let n = 0; // カウンタ
      // 全チケットを走査
      for (const t of store.tickets.values()) {
        if (t.status !== status) continue; // 状態が違えばスキップ
        if (creatorId !== undefined && t.creatorId !== creatorId) continue; // 起票者指定を反映
        n += 1; // カウントアップ
      }
      // 件数を返す
      return n;
    },

    // SLA 期限超過 (未解決) 件数をカウント
    async countSlaOverdue(now) {
      let n = 0; // カウンタ
      // 全チケットを走査
      for (const t of store.tickets.values()) {
        if (!t.resolutionDueAt) continue; // 期限未設定はスキップ
        if (t.resolutionDueAt >= now) continue; // 期限未到来はスキップ
        if (t.resolvedAt !== null) continue; // 解決済みはスキップ
        if (t.status === 'Resolved' || t.status === 'Closed') continue; // 終息状態もスキップ
        n += 1; // 超過として加算
      }
      // 件数を返す
      return n;
    },

    // 担当者別の保持チケット件数を取得 (指定状態は除外)
    async workloadByAssignee({ excludeStatuses }) {
      // 担当者 ID ごとの件数カウント用 Map
      const counts = new Map<string | null, number>();
      // 全チケットを走査
      for (const t of store.tickets.values()) {
        if (excludeStatuses.includes(t.status)) continue; // 除外状態ならスキップ
        // 現在の件数に 1 を加算してセット
        counts.set(t.assigneeId, (counts.get(t.assigneeId) ?? 0) + 1);
      }
      // Map を配列形式 (AssigneeWorkloadRow) に変換
      const rows: AssigneeWorkloadRow[] = [...counts.entries()].map(([assigneeId, count]) => ({
        assigneeId,
        count,
      }));
      // 件数の多い順に並び替え
      rows.sort((a, b) => b.count - a.count);
      // 結果を返す
      return rows;
    },

    // 新規チケットを作成 (初期状態は 'New')
    async create(input) {
      const now = new Date(); // 作成時刻
      // 新規チケット行を組み立て
      const ticket: Ticket = {
        id: nextId(store, 'tkt'), // 'tkt_...' 形式の一意 ID
        title: input.title,
        body: input.body,
        status: 'New', // 新規状態でスタート
        priority: input.priority,
        createdAt: now,
        updatedAt: now,
        firstResponseDueAt: input.firstResponseDueAt ?? null,
        resolutionDueAt: input.resolutionDueAt ?? null,
        firstRespondedAt: null,
        resolvedAt: null,
        escalatedAt: null,
        escalationReason: null,
        creatorId: input.creatorId,
        assigneeId: null, // 初期は未アサイン
        categoryId: input.categoryId,
      };
      // ストアに登録
      store.tickets.set(ticket.id, ticket);
      // 関連情報を付けて返却
      return attachRefs(ticket, store);
    },

    // 状態を更新 (併せて解決日時もセットする)
    async updateStatus(id, status, resolvedAt) {
      const t = store.tickets.get(id); // 対象取得
      if (!t) throw new Error(`ticket not found: ${id}`); // 無ければエラー
      // 新しい状態/解決日時/更新時刻で置き換え
      store.tickets.set(id, { ...t, status, resolvedAt, updatedAt: new Date() });
    },

    // 優先度を更新
    async updatePriority(id, priority) {
      const t = store.tickets.get(id);
      if (!t) throw new Error(`ticket not found: ${id}`);
      store.tickets.set(id, { ...t, priority, updatedAt: new Date() });
    },

    // 担当者を更新 (null で未アサインに戻す)
    async updateAssignee(id, assigneeId) {
      const t = store.tickets.get(id);
      if (!t) throw new Error(`ticket not found: ${id}`);
      store.tickets.set(id, { ...t, assigneeId, updatedAt: new Date() });
    },

    // エスカレーション扱いに更新 (状態 + 理由 + 実行時刻)
    async markEscalated(id, args) {
      const t = store.tickets.get(id);
      if (!t) throw new Error(`ticket not found: ${id}`);
      store.tickets.set(id, {
        ...t,
        status: 'Escalated',
        escalatedAt: args.at,
        escalationReason: args.reason,
        updatedAt: new Date(),
      });
    },
  };
}
