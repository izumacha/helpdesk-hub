// LINE 連携コード冪等化記録リポジトリの契約 (port) と Prisma 共通型をインポート
import type { LineLinkCodeRepository } from '@/data/ports/line-link-code-repository';
import type { PrismaLike } from './types';

// Prisma クライアントを使った LineLinkCodeRef リポジトリを生成する関数
export function makeLineLinkCodeRepo(db: PrismaLike): LineLinkCodeRepository {
  return {
    // messageId が既に連携コードとして処理済みかを判定する
    async wasProcessed(messageId) {
      const row = await db.lineLinkCodeRef.findUnique({
        where: { lineMessageId: messageId },
        select: { id: true }, // 存在確認のみなので id だけ取得
      });
      return row !== null;
    },

    // messageId を処理済みとして記録する (冪等)
    async markProcessed(messageId) {
      // createMany + skipDuplicates で「既に同じ messageId があれば無視」する
      // (LineMessageRepository.register と同じパターン)。Webhook の再送でも例外を投げない
      await db.lineLinkCodeRef.createMany({
        data: [{ lineMessageId: messageId }],
        skipDuplicates: true,
      });
    },
  };
}
