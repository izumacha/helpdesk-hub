// 添付メタデータ用リポジトリの Prisma 実装。
// 取得/削除系は tenantId 必須化済で、他テナントの ID は問答無用で null/no-op となる。

// Port 契約と関連型を取り込む
import type {
  AttachmentRepository,
  CreateAttachmentInput,
} from '@/data/ports/attachment-repository';
// ドメイン型 (添付ファイル)
import type { Attachment, AttachmentStorageKind } from '@/domain/attachment';
// Prisma が生成した Attachment 行型 (include 無しの素の型)
import type { Prisma } from '@/generated/prisma';
// Prisma クライアント or トランザクションの共通型
import type { PrismaLike } from './types';

// Prisma の Attachment 行型のエイリアス (include なし)
type AttachmentRow = Prisma.AttachmentGetPayload<Record<string, never>>;

// Prisma 行をドメイン型へ詰め替える純粋関数
function toAttachment(row: AttachmentRow): Attachment {
  // 必要なフィールドだけを抜き出してドメイン型に整形する
  return {
    id: row.id,
    ticketId: row.ticketId,
    commentId: row.commentId,
    uploaderId: row.uploaderId,
    tenantId: row.tenantId,
    mimeType: row.mimeType,
    size: row.size,
    originalName: row.originalName,
    storageKey: row.storageKey,
    storage: row.storage as AttachmentStorageKind, // Prisma enum をドメイン union にキャスト
    createdAt: row.createdAt,
  };
}

// Prisma クライアント (または tx クライアント) を受け取り、Port 実装を返すファクトリ
export function makeAttachmentRepo(db: PrismaLike): AttachmentRepository {
  return {
    // 1 件作成して作成結果をドメイン型で返す
    async create(input: CreateAttachmentInput) {
      // Prisma クライアントで INSERT する
      const row = await db.attachment.create({
        data: {
          ticketId: input.ticketId, // 親チケット
          commentId: input.commentId, // 紐づくコメント (null 可)
          uploaderId: input.uploaderId, // アップローダー
          tenantId: input.tenantId, // テナントスコープ
          mimeType: input.mimeType, // MIME (検証済)
          size: input.size, // バイト数
          originalName: input.originalName, // 元ファイル名
          storageKey: input.storageKey, // 保存先キー
          storage: input.storage, // 保存方式
        },
      });
      // ドメイン型に詰め替えて返す
      return toAttachment(row);
    },

    // ID + tenantId で 1 件取得 (他テナントの ID なら null)
    async findById(id, tenantId) {
      // findFirst で id + tenantId の AND 一致を検索する
      const row = await db.attachment.findFirst({ where: { id, tenantId } });
      // 見つかれば詰め替えて、見つからなければ null を返す
      return row ? toAttachment(row) : null;
    },

    // チケット ID + tenantId で添付一覧を古い順に取得する
    async listByTicket(ticketId, tenantId) {
      // 古い順 (作成日時 asc) でソートして取得する
      const rows = await db.attachment.findMany({
        where: { ticketId, tenantId },
        orderBy: { createdAt: 'asc' },
      });
      // 各行をドメイン型に詰め替えた配列を返す
      return rows.map(toAttachment);
    },

    // チケット ID + tenantId で添付件数を返す (5 枚上限のチェックに使用)
    async countByTicket(ticketId, tenantId) {
      // count() で WHERE 一致の件数のみ取得する (行は取得しない)
      return db.attachment.count({ where: { ticketId, tenantId } });
    },

    // テナント全体の添付サイズ合計 (バイト) を返す (添付累計サイズ上限チェック用)
    async sumSizeByTenant(tenantId) {
      // aggregate の SUM を使い、行を取得せず集計だけ DB 側で行う
      const result = await db.attachment.aggregate({
        where: { tenantId },
        _sum: { size: true },
      });
      // 該当行が無い場合 _sum.size は null になるため 0 にフォールバックする
      return result._sum.size ?? 0;
    },

    // ID + tenantId で 1 件削除 (他テナントの ID は 0 件削除となり no-op)
    async delete(id, tenantId) {
      // updateMany と同じく deleteMany で AND 一致のみ削除する
      await db.attachment.deleteMany({ where: { id, tenantId } });
    },
  };
}
