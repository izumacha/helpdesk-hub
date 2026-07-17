// SAML アサーションのリプレイ防止記録リポジトリの契約 (port) と Prisma 共通型をインポート
import type { SamlAssertionRepository } from '@/data/ports/saml-assertion-repository';
// Prisma の一意制約違反 (P2002) 判定の共通ヘルパー (line-config-repository.prisma.ts 等と共有 / §6 DRY)
import { isUniqueConstraintError } from '@/lib/prisma-errors';
import type { PrismaLike } from './types';

// Prisma クライアントを使った SamlAssertionRef リポジトリを生成する関数
export function makeSamlAssertionRepo(db: PrismaLike): SamlAssertionRepository {
  return {
    // (tenantId, assertionId) が初回利用なら記録して true、既に記録済み (リプレイ) なら false
    async recordIfNew({ tenantId, assertionId }) {
      try {
        // 一意制約 (@@unique([tenantId, assertionId])) を使ったアトミックな「初回のみ作成」。
        // 同時に同じアサーションで 2 リクエストが来ても、DB の一意制約が片方だけを通す。
        await db.samlAssertionRef.create({ data: { tenantId, assertionId } });
        return true; // 初回利用として記録できた
      } catch (err) {
        // 一意制約違反 = 既に同じ (tenantId, assertionId) が記録済み (リプレイ)
        if (isUniqueConstraintError(err)) return false;
        // それ以外の失敗 (DB 接続エラー等) は原因不明として呼び出し側に再送出する
        throw err;
      }
    },
  };
}
