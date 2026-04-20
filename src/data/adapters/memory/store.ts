// ドメイン型をインポート (メモリストア内に保持するデータ型)
import type {
  FaqCandidate,
  Notification,
  Ticket,
  TicketComment,
  TicketHistory,
  User,
} from '@/domain/types';

// メモリ内で保持するカテゴリ行 (id/name/作成日時)
export interface CategoryRow {
  id: string; // カテゴリ ID
  name: string; // カテゴリ名
  createdAt: Date; // 作成日時
}

/**
 * In-memory store used by the test adapter.
 *
 * The `idSeq` counter is per-store so different test contexts never share state
 * and produce stable id sequences in isolation.
 */
// テスト用メモリストアの型。エンティティごとに Map を持つ
export interface Store {
  users: Map<string, User>; // ユーザー
  categories: Map<string, CategoryRow>; // カテゴリ
  tickets: Map<string, Ticket>; // チケット
  comments: Map<string, TicketComment>; // コメント
  histories: Map<string, TicketHistory>; // 履歴
  faq: Map<string, FaqCandidate>; // FAQ 候補
  notifications: Map<string, Notification>; // 通知
  idSeq: { value: number }; // 連番生成用のカウンタ (オブジェクトに包んで参照共有)
}

// 空のストアを作って返すファクトリ関数
export function createEmptyStore(): Store {
  // 全エンティティを空の Map とし、連番を 0 から開始
  return {
    users: new Map(),
    categories: new Map(),
    tickets: new Map(),
    comments: new Map(),
    histories: new Map(),
    faq: new Map(),
    notifications: new Map(),
    idSeq: { value: 0 },
  };
}

// ストアを浅くコピーする関数 (トランザクション擬似実装のスナップショット用)
export function cloneStore(src: Store): Store {
  // 各 Map を複製し、連番カウンタの値もコピー
  return {
    users: new Map(src.users),
    categories: new Map(src.categories),
    tickets: new Map(src.tickets),
    comments: new Map(src.comments),
    histories: new Map(src.histories),
    faq: new Map(src.faq),
    notifications: new Map(src.notifications),
    idSeq: { value: src.idSeq.value },
  };
}

// dst の中身を src で上書きする関数 (ロールバック用)
export function overwriteStore(dst: Store, src: Store): void {
  // 各エンティティを src のコピーで置き換える
  dst.users = new Map(src.users);
  dst.categories = new Map(src.categories);
  dst.tickets = new Map(src.tickets);
  dst.comments = new Map(src.comments);
  dst.histories = new Map(src.histories);
  dst.faq = new Map(src.faq);
  dst.notifications = new Map(src.notifications);
  // 連番も元に戻す
  dst.idSeq.value = src.idSeq.value;
}

/**
 * Per-store id generator. Not a real cuid — the contract test only requires
 * that ids are unique within a store.
 */
// ストア単位の ID 生成関数 (テスト内で一意であれば十分)
export function nextId(store: Store, prefix: string): string {
  // カウンタをインクリメント
  store.idSeq.value += 1;
  // prefix + 36 進カウンタ + ランダム文字列 で ID を構築して返す
  return `${prefix}_${store.idSeq.value.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
