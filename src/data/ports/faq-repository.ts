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

// FAQ リポジトリの契約 (port)
// 全メソッドが tenantId 必須化済み。テナント越境参照/更新を Adapter 層で遮断する
export interface FaqRepository {
  // ID + tenantId で 1 件取得 (他テナントの ID なら null)
  findById(id: string, tenantId: string): Promise<FaqCandidate | null>;
  // 当該テナントの FAQ 候補一覧を取得
  list(tenantId: string): Promise<FaqListItem[]>;
  // 候補を作成 (input.tenantId 必須)
  create(input: CreateFaqInput): Promise<FaqCandidate>;
  // 公開/却下などの状態更新 (tenantId スコープ。他テナントの ID なら 0 件更新で no-op)
  updateStatus(id: string, status: FaqStatus, tenantId: string): Promise<void>;
}
