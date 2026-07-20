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
      // expected が渡された場合は CAS (compare-and-swap) 経路: 「読み取り時点の値」を
      // where に足した updateMany で、書き込み直前にも現在値が一致することを保証する
      // (update-notification-channels.ts の updateNotificationChannels と同じ方針)。
      // expected は「既存設定がある」ことを前提にした呼び出し (呼び出し側は既存行が無ければ
      // expected を渡さない契約) のため、ここでは無条件に updateMany を使う
      if (input.expected) {
        const result = await db.tenantLineConfig.updateMany({
          where: {
            tenantId: input.tenantId,
            channelSecret: input.expected.channelSecret,
            channelAccessToken: input.expected.channelAccessToken,
            botUserId: input.expected.botUserId,
          },
          data: {
            channelSecret: input.channelSecret,
            channelAccessToken: input.channelAccessToken,
            botUserId: input.botUserId,
          },
        });
        // 0 件更新 = 読み取り後に他の管理者が値を変えていた (競合)。呼び出し側へ null を返し、
        // 後勝ちで上書きしないようにする (§9 fail-closed)
        if (result.count === 0) return null;
        // 更新できた行を読み直してドメイン型で返す (updateMany は更新後の行を返さないため)。
        // findUniqueOrThrow だと、この直後 (更新成功〜読み直しの間) に別リクエストが同じ設定を
        // 削除する極めて稀な競合で例外を投げてしまい、呼び出し側の catch が「保存に失敗しました」
        // という誤解を招く汎用エラーにしてしまう (実際には更新自体は成功していた)。
        // findUnique + null チェックにして、その競合ケースも「他の更新と競合した」という
        // 一貫したメッセージ (null 相当) に丸める
        const row = await db.tenantLineConfig.findUnique({ where: { tenantId: input.tenantId } });
        if (!row) return null;
        return toLineConfig(row);
      }

      // expected 未指定: 従来どおりの無条件 upsert (新規作成、または競合検知が不要な呼び出し)。
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
          channelSecret: input.channelSecret, // Webhook 署名検証用シークレット
          channelAccessToken: input.channelAccessToken, // Messaging API push 用アクセストークン
          botUserId: input.botUserId, // このチャネルの Bot User ID
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
