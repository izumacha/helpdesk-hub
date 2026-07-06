// LINE 連携設定リポジトリの契約 (port)
import type { LineConfigRepository } from '@/data/ports/line-config-repository';
// ドメイン型
import type { TenantLineConfig } from '@/domain/types';
// Prisma の行型
import type { Prisma } from '@/generated/prisma';
// Prisma クライアント/トランザクション共通型
import type { PrismaLike } from './types';

// Prisma の TenantLineConfig 行 (include なし) の型エイリアス
type LineConfigRow = Prisma.TenantLineConfigGetPayload<Record<string, never>>;

// Prisma の行をドメイン型に変換する関数
function toLineConfig(row: LineConfigRow): TenantLineConfig {
  // 必要なフィールドだけ詰め替えて返す
  return {
    id: row.id, // 設定 ID
    tenantId: row.tenantId, // 所属テナント (マルチテナント化のキー)
    channelSecret: row.channelSecret, // Webhook 署名検証用シークレット
    channelAccessToken: row.channelAccessToken, // Messaging API push 用アクセストークン
    botUserId: row.botUserId, // このチャネルの Bot User ID (テナント解決キー)
    createdAt: row.createdAt, // 作成日時
    updatedAt: row.updatedAt, // 更新日時
  };
}

// Prisma クライアントを使った LINE 連携設定リポジトリを生成するファクトリ関数
export function makeLineConfigRepo(db: PrismaLike): LineConfigRepository {
  return {
    // テナントの LINE 連携設定を取得する (未設定なら null)
    async findByTenant(tenantId) {
      // tenantId は @unique なので findUnique で 1 件取得する
      const row = await db.tenantLineConfig.findUnique({ where: { tenantId } });
      // 見つからなければ null、見つかればドメイン型に変換して返す
      return row ? toLineConfig(row) : null;
    },

    // destination (Bot User ID) からテナントの LINE 連携設定を取得する (未登録なら null)
    async findByBotUserId(botUserId) {
      // botUserId も @unique なので findUnique で 1 件取得する
      const row = await db.tenantLineConfig.findUnique({ where: { botUserId } });
      return row ? toLineConfig(row) : null;
    },

    // LINE 連携設定を作成または更新する (tenantId をキーに upsert)
    async upsert(input) {
      // tenantId が既存なら update、なければ create される。botUserId の @unique 制約に
      // 反する場合 (他テナントが同じチャネルを既に登録済み) は Prisma が P2002 を投げる
      // (呼び出し側の Server Action がユーザー向けメッセージへ変換する)
      const row = await db.tenantLineConfig.upsert({
        where: { tenantId: input.tenantId },
        // 新規作成時の値
        create: {
          tenantId: input.tenantId, // 所属テナント (セッション由来のみ)
          channelSecret: input.channelSecret, // Webhook 署名検証用シークレット
          channelAccessToken: input.channelAccessToken, // Messaging API push 用アクセストークン
          botUserId: input.botUserId, // このチャネルの Bot User ID
        },
        // 既存更新時の値 (tenantId は変更しない)
        update: {
          channelSecret: input.channelSecret,
          channelAccessToken: input.channelAccessToken,
          botUserId: input.botUserId,
        },
      });
      // 作成/更新後の行をドメイン型に変換して返す
      return toLineConfig(row);
    },

    // テナントの LINE 連携設定を削除する (tenantId スコープ)
    async delete(tenantId) {
      // deleteMany は該当行が無くてもエラーにならない (冪等)。tenantId スコープでクロステナント防止
      await db.tenantLineConfig.deleteMany({ where: { tenantId } });
    },
  };
}
