// ドメイン型 (FAQ 候補/FAQ 状態) をインポート
import type { FaqCandidate, FaqStatus } from '@/domain/types';

// FAQ 一覧 (list/listPublished 共通) の既定件数上限。
// フォローアップ (2026-07-16 #3): list/listPublished が上限なしで全件取得しており、
// CLAUDE.md §8「一覧取得は必ず上限・ページネーションを持たせる」に反していた
// (FAQ 候補は解決済みチケットから継続的に積み上がる性質上、無制限に増え得る)。
// audit ログの PAGE_LIMIT (200 件) と同じ規模感に揃える
export const FAQ_LIST_LIMIT = 200;

// 呼び出し側が指定した limit を FAQ_LIST_LIMIT 以下にクランプする。
// /code-review ultra 指摘対応: 現状の唯一の呼び出し元 (/faq ページ) は常に FAQ_LIST_LIMIT
// そのものを渡すため実害はないが、audit/quarantine の `resolveAuditLimit`
// （`src/data/adapters/audit-pagination.ts`）と同じく、将来 Server Action や API が
// ユーザー入力由来の limit をそのまま渡すようになっても Prisma/メモリ両アダプタ側で
// 無制限クエリにならないよう、アダプタ層でも下限として機能させる (fail-closed の多層防御)
export function resolveFaqListLimit(requested: number): number {
  return Math.min(requested, FAQ_LIST_LIMIT);
}

// FAQ 候補を新規作成するときの入力値
export interface CreateFaqInput {
  ticketId: string; // 元となったチケット ID
  createdById: string; // 候補化したユーザー ID
  question: string; // 質問文
  answer: string; // 回答文
  tenantId: string; // 所属テナント ID (マルチテナント化のキー)
}

// 一覧表示用の FAQ アイテム (関連チケットと作成者名を同梱)
export interface FaqListItem extends FaqCandidate {
  ticket: { id: string; title: string }; // 元チケットの要約
  createdBy: { name: string }; // 作成者の氏名
}

// フォローアップ (2026-07-14 #5): 依頼者 (非エージェント) 向けの公開済み FAQ 閲覧用アイテム。
// 元チケット/作成者などの内部情報は意図的に含めない (§9 最小権限・最小公開の方針。
// quarantine の「本文は保存しない」と同じ範囲最小化の考え方)
export interface PublishedFaqItem {
  id: string; // FAQ 候補 ID
  question: string; // 質問文
  answer: string; // 回答文
}

// FAQ リポジトリの契約 (port)
// 全メソッドが tenantId 必須化済み。テナント越境参照/更新を Adapter 層で遮断する
export interface FaqRepository {
  // ID + tenantId で 1 件取得 (他テナントの ID なら null)
  findById(id: string, tenantId: string): Promise<FaqCandidate | null>;
  // 当該テナントの FAQ 候補一覧を取得 (エージェント向け管理画面用。全ステータスを含む)。
  // opts.limit で新しい順に取得件数を上限化する (フォローアップ 2026-07-16 #3)
  list(tenantId: string, opts: { limit: number }): Promise<FaqListItem[]>;
  // 当該テナントの公開済み (Published) FAQ 一覧を取得する (依頼者含む全メンバーが閲覧可能。
  // フォローアップ 2026-07-14 #5)。opts.limit で新しい順に取得件数を上限化する
  // (フォローアップ 2026-07-16 #3)
  listPublished(tenantId: string, opts: { limit: number }): Promise<PublishedFaqItem[]>;
  // 候補を作成 (input.tenantId 必須)
  create(input: CreateFaqInput): Promise<FaqCandidate>;
  // 公開/却下などの状態更新 (tenantId スコープ。他テナントの ID なら 0 件更新で no-op)。
  // フォローアップ (2026-07-15): transition.from (期待する現在状態) を where 条件に含めた
  // 原子的更新にし、読み取り後〜書き込み前に別の操作が状態を変えていた場合 (check-then-act 競合)
  // は更新せず false を返す。呼び出し元はドメイン遷移表 (isValidFaqTransition) で from→to の
  // 妥当性を検証したうえで呼び、false なら競合として扱う
  updateStatus(
    id: string,
    transition: { from: FaqStatus; to: FaqStatus },
    tenantId: string,
  ): Promise<boolean>;
  // 質問/回答の本文を更新 (tenantId スコープ。他テナントの ID なら 0 件更新で no-op)
  // フォローアップ (2026-07-14 #6): 公開後に誤りへ気付いても訂正手段が無かったギャップ対応
  updateContent(
    id: string,
    content: { question: string; answer: string },
    tenantId: string,
  ): Promise<void>;
}
