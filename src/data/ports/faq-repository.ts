// ドメイン型 (FAQ 候補/FAQ 状態) をインポート
import type { FaqCandidate, FaqStatus } from '@/domain/types';

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
  // 当該テナントの FAQ 候補一覧を取得 (エージェント向け管理画面用。全ステータスを含む)
  list(tenantId: string): Promise<FaqListItem[]>;
  // 当該テナントの公開済み (Published) FAQ 一覧を取得する (依頼者含む全メンバーが閲覧可能。
  // フォローアップ 2026-07-14 #5)
  listPublished(tenantId: string): Promise<PublishedFaqItem[]>;
  // 候補を作成 (input.tenantId 必須)
  create(input: CreateFaqInput): Promise<FaqCandidate>;
  // 公開/却下などの状態更新 (tenantId スコープ。他テナントの ID なら 0 件更新で no-op)
  updateStatus(id: string, status: FaqStatus, tenantId: string): Promise<void>;
  // 質問/回答の本文を更新 (tenantId スコープ。他テナントの ID なら 0 件更新で no-op)
  // フォローアップ (2026-07-14 #6): 公開後に誤りへ気付いても訂正手段が無かったギャップ対応
  updateContent(
    id: string,
    content: { question: string; answer: string },
    tenantId: string,
  ): Promise<void>;
}
