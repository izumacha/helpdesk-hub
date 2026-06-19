// InvitationRepository の契約 (port) をインポート
import type { InvitationRepository } from '@/data/ports/invitation-repository';
// Prisma 行 → ドメイン型のマッパー
import { toInvitation } from './mappers';
// Prisma クライアント/トランザクション共通型
import type { PrismaLike } from './types';

// Prisma クライアントを使った Invitation リポジトリを生成する関数
export function makeInvitationRepo(db: PrismaLike): InvitationRepository {
  return {
    // 新規招待を 1 件作成して保存する
    async create(input) {
      // Prisma 経由で行を作成
      const row = await db.invitation.create({
        data: {
          tokenHash: input.tokenHash, // 生トークンの SHA-256 ハッシュ
          tenantId: input.tenantId, // 参加先テナント
          role: input.role, // 付与する権限
          expiresAt: input.expiresAt, // 失効時刻
          email: input.email ?? null, // 宛先メール (任意)
          invitedById: input.invitedById ?? null, // 発行者 (任意)
        },
      });
      // 作成行をドメイン型に変換して返す
      return toInvitation(row);
    },

    // tokenHash で 1 件取得 (見つからなければ null)
    async findByTokenHash(tokenHash) {
      // tokenHash は @unique なので findUnique で確実に 1 件取れる
      const row = await db.invitation.findUnique({ where: { tokenHash } });
      // 見つかればドメイン型に変換、見つからなければ null
      return row ? toInvitation(row) : null;
    },

    // tokenHash で「未消費かつ失効前」の招待を原子的に消費する。
    // Prisma の updateMany は単一 SQL (UPDATE ... WHERE ...) として評価され、
    // PostgreSQL の行ロックで並行クリックでも成功は 1 件に限られる。
    async consumeValidToken({ tokenHash, now }) {
      // 1 単一 UPDATE: 「未消費 (consumedAt IS NULL) かつ 失効前 (expiresAt >= now)」の行に消費印を立てる
      const result = await db.invitation.updateMany({
        where: {
          tokenHash, // 検索キー (@unique なので最大 1 件)
          consumedAt: null, // まだ使われていない
          expiresAt: { gte: now }, // 失効していない
        },
        data: { consumedAt: now }, // 消費時刻を打刻
      });
      // 0 件 = 既に消費済み / 失効 / 不在 のいずれか
      if (result.count !== 1) return null;
      // 消費直後の行を取り直して tenantId / role 等を呼び出し側へ返す
      const row = await db.invitation.findUnique({ where: { tokenHash } });
      return row ? toInvitation(row) : null;
    },

    // 指定 ID を 1 件物理削除する (rollback 用)。存在しない ID でも例外で落とさない
    async deleteById(id) {
      // 既に消えている場合に Prisma の P2025 (record not found) を投げさせないよう deleteMany を使う
      await db.invitation.deleteMany({ where: { id } });
    },

    // expiresAt が now より前の招待を一括削除して件数を返す
    async deleteExpired(now) {
      // 期限切れのものを deleteMany で物理削除
      const result = await db.invitation.deleteMany({
        where: { expiresAt: { lt: now } },
      });
      // 削除件数 (Prisma の戻り値 .count) を返す
      return result.count;
    },

    // 指定テナント宛に since 以降に発行された招待件数を数える (レート制限用)
    async countRecentByTenant(tenantId, since) {
      // tenantId + createdAt >= since で件数取得
      return db.invitation.count({
        where: { tenantId, createdAt: { gte: since } },
      });
    },
  };
}
