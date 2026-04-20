// ドメイン型 (FAQ 候補/FAQ 状態) をインポート
import type { FaqCandidate, FaqStatus } from '@/domain/types';

// FAQ 候補を新規作成するときの入力値
export interface CreateFaqInput {
  ticketId: string; // 元となったチケット ID
  createdById: string; // 候補化したユーザー ID
  question: string; // 質問文
  answer: string; // 回答文
}

// 一覧表示用の FAQ アイテム (関連チケットと作成者名を同梱)
export interface FaqListItem extends FaqCandidate {
  ticket: { id: string; title: string }; // 元チケットの要約
  createdBy: { name: string }; // 作成者の氏名
}

// FAQ リポジトリの契約 (port)
export interface FaqRepository {
  findById(id: string): Promise<FaqCandidate | null>; // ID で 1 件取得
  list(): Promise<FaqListItem[]>; // 一覧取得
  create(input: CreateFaqInput): Promise<FaqCandidate>; // 候補を作成
  updateStatus(id: string, status: FaqStatus): Promise<void>; // 公開/却下などの状態更新
}
