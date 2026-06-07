// ドメイン型 (コメント) をインポート
import type { TicketComment } from '@/domain/types';

// コメント作成時に渡す入力値
//
// セキュリティ不変条件 (issue #123): `tenantId` は **必ず認証済みセッション
// (`session.user.tenantId`) から取得**すること。リクエストボディ・クエリ・フォーム値など
// 攻撃者が制御できる入力から渡してはならない。Adapter は「親チケットが渡された tenantId に
// 属するか」しか検証しないため、tenantId 自体がスプーフィングされるとガードを回避できる。
export interface CreateCommentInput {
  ticketId: string; // 対象チケット ID
  authorId: string; // 書き込みユーザー ID
  body: string; // コメント本文
  tenantId: string; // 所属テナント ID (セッション由来必須)。親チケットがこのテナントに属することを Adapter が検証する
}

// コメント書き込み用リポジトリの契約 (port)
export interface TicketCommentRepository {
  create(input: CreateCommentInput): Promise<TicketComment>; // 1 件作成し、作成結果を返す
}
