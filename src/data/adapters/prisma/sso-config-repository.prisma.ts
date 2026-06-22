// SSO 設定リポジトリの契約 (port)
import type { SsoConfigRepository } from '@/data/ports/sso-config-repository';
// ドメイン型
import type { TenantSsoConfig } from '@/domain/types';
// Prisma の行型
import type { Prisma } from '@/generated/prisma';
// Prisma クライアント/トランザクション共通型
import type { PrismaLike } from './types';

// Prisma の TenantSsoConfig 行 (include なし) の型エイリアス
type SsoConfigRow = Prisma.TenantSsoConfigGetPayload<Record<string, never>>;

// Prisma の行をドメイン型に変換する関数
function toSsoConfig(row: SsoConfigRow): TenantSsoConfig {
  // 必要なフィールドだけ詰め替えて返す
  return {
    id: row.id, // 設定 ID
    tenantId: row.tenantId, // 所属テナント (マルチテナント化のキー)
    enabled: row.enabled, // 有効フラグ
    idpEntityId: row.idpEntityId, // IdP の EntityID
    idpSsoUrl: row.idpSsoUrl, // IdP の SSO エンドポイント
    idpX509Cert: row.idpX509Cert, // IdP の署名検証用証明書
    createdAt: row.createdAt, // 作成日時
    updatedAt: row.updatedAt, // 更新日時
  };
}

// Prisma クライアントを使った SSO 設定リポジトリを生成するファクトリ関数
export function makeSsoConfigRepo(db: PrismaLike): SsoConfigRepository {
  return {
    // テナントの SSO 設定を取得する (未設定なら null)
    async findByTenant(tenantId) {
      // tenantId は @unique なので findUnique で 1 件取得する
      const row = await db.tenantSsoConfig.findUnique({ where: { tenantId } });
      // 見つからなければ null、見つかればドメイン型に変換して返す
      return row ? toSsoConfig(row) : null;
    },

    // SSO 設定を作成または更新する (tenantId をキーに upsert)
    async upsert(input) {
      // tenantId が既存なら update、なければ create される
      const row = await db.tenantSsoConfig.upsert({
        where: { tenantId: input.tenantId },
        // 新規作成時の値
        create: {
          tenantId: input.tenantId, // 所属テナント (セッション由来のみ)
          enabled: input.enabled, // 有効フラグ
          idpEntityId: input.idpEntityId, // IdP の EntityID
          idpSsoUrl: input.idpSsoUrl, // IdP の SSO エンドポイント
          idpX509Cert: input.idpX509Cert, // IdP の署名検証用証明書
        },
        // 既存更新時の値 (tenantId は変更しない)
        update: {
          enabled: input.enabled,
          idpEntityId: input.idpEntityId,
          idpSsoUrl: input.idpSsoUrl,
          idpX509Cert: input.idpX509Cert,
        },
      });
      // 作成/更新後の行をドメイン型に変換して返す
      return toSsoConfig(row);
    },

    // テナントの SSO 設定を削除する (tenantId スコープ)
    async delete(tenantId) {
      // deleteMany は該当行が無くてもエラーにならない (冪等)。tenantId スコープでクロステナント防止
      await db.tenantSsoConfig.deleteMany({ where: { tenantId } });
    },
  };
}
