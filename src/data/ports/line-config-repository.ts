// Phase 2 フォローアップ: テナント単位の LINE 公式アカウント連携設定リポジトリの契約 (port)
// docs/smb-dx-pivot-plan.md §4 Phase 2.1

// LINE 連携設定ドメイン型
import type { TenantLineConfig } from '@/domain/types';

// LINE 連携設定リポジトリの契約 (port)。1 テナント 1 設定をテナントスコープで操作する
export interface LineConfigRepository {
  // テナントの LINE 連携設定を取得する (未設定なら null)
  findByTenant(tenantId: string): Promise<TenantLineConfig | null>;
  // LINE の destination (Bot User ID) からテナントの LINE 連携設定を取得する (未登録なら null)。
  // Webhook 受信時に「署名検証前の公開識別子からテナントを特定する」ために使う
  // (メール取り込みの inboundToken と同じ設計。botUserId 自体は秘密情報ではない)。
  findByBotUserId(botUserId: string): Promise<TenantLineConfig | null>;
  // LINE 連携設定を作成または更新する (1 テナント 1 設定なので tenantId で upsert)
  upsert(input: {
    tenantId: string; // 所属テナント (セッション由来のみ許可。クロステナント設定防止)
    channelSecret: string; // Webhook 署名検証用シークレット
    channelAccessToken: string; // Messaging API push 用の長期アクセストークン
    botUserId: string; // このチャネルの Bot User ID (destination 値)
  }): Promise<TenantLineConfig>;
  // テナントの LINE 連携設定を削除する (tenantId スコープで他テナントは no-op)
  delete(tenantId: string): Promise<void>;
}
