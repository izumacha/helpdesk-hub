// MagicLinkRepository の契約 (port) をインポート
import type { MagicLinkRepository } from '@/data/ports/magic-link-repository';
// Prisma 行 → ドメイン型のマッパー
import { toMagicLinkToken } from './mappers';
// Prisma クライアント/トランザクション共通型
import type { PrismaLike } from './types';

// Prisma クライアントを使った MagicLinkToken リポジトリを生成する関数
export function makeMagicLinkRepo(db: PrismaLike): MagicLinkRepository {
  return {
    // 新規トークンを 1 件作成して保存する
    async create(input) {
      // Prisma 経由で行を作成
      const row = await db.magicLinkToken.create({
        data: {
          email: input.email, // 送信先メール
          tokenHash: input.tokenHash, // 生トークンの SHA-256 ハッシュ
          expiresAt: input.expiresAt, // 失効時刻
          requestedIp: input.requestedIp ?? null, // 発行リクエスト元 IP (任意)
        },
      });
      // 作成行をドメイン型に変換して返す
      return toMagicLinkToken(row);
    },

    // tokenHash で 1 件取得 (見つからなければ null)
    async findByTokenHash(tokenHash) {
      // tokenHash は @unique なので findUnique で確実に 1 件取れる
      const row = await db.magicLinkToken.findUnique({ where: { tokenHash } });
      // 見つかればドメイン型に変換、見つからなければ null
      return row ? toMagicLinkToken(row) : null;
    },

    // 指定 ID に consumedAt を立てて単回使用を強制する
    async markConsumed(id) {
      // updateMany を使うのは「既に消費済みなら 0 件で済ませる」ためではなく、
      // 単純に id 一致で 1 件更新する目的。失敗時の例外を避けたいので update でなく updateMany
      await db.magicLinkToken.update({
        where: { id },
        data: { consumedAt: new Date() },
      });
    },

    // expiresAt が now より前のトークンを一括削除して件数を返す
    async deleteExpired(now) {
      // 期限切れのものを deleteMany で物理削除
      const result = await db.magicLinkToken.deleteMany({
        where: { expiresAt: { lt: now } },
      });
      // 削除件数 (Prisma の戻り値 .count) を返す
      return result.count;
    },

    // 指定メール宛に since 以降に発行されたトークン件数を数える (レート制限用)
    async countRecentByEmail(email, since) {
      // email + createdAt >= since で件数取得
      return db.magicLinkToken.count({
        where: { email, createdAt: { gte: since } },
      });
    },
  };
}
