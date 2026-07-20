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
  // LINE 連携設定を作成または更新する (1 テナント 1 設定なので tenantId で upsert)。
  // フォローアップ (監査で発見したギャップ): update-line-config.ts は channelSecret /
  // channelAccessToken が空欄送信されたとき「読み取り時点の既存値を引き継ぐ」処理を
  // 挟むため、読み取り→無条件書き込みの間に他の管理者の並行更新が割り込むと check-then-act
  // (TOCTOU) で後勝ち上書きが起きうる (update-notification-channels.ts の
  // updateNotificationChannels で既に対応済みの同種の穴)。expected を渡した場合のみ、
  // 書き込み直前にも現在値が一致することを DB レベルで保証する CAS になる。
  upsert(input: {
    tenantId: string; // 所属テナント (セッション由来のみ許可。クロステナント設定防止)
    channelSecret: string; // Webhook 署名検証用シークレット
    channelAccessToken: string; // Messaging API push 用の長期アクセストークン
    botUserId: string; // このチャネルの Bot User ID (destination 値)
    // CAS: 読み取り時点の既存設定値。渡された場合、書き込み直前の現在値がこれと一致する
    // ときだけ更新する。未指定 (新規作成、または呼び出し側が競合検知を必要としない場合) なら
    // 従来どおり無条件 upsert する。
    expected?: {
      channelSecret: string;
      channelAccessToken: string;
      botUserId: string;
    };
  }): Promise<TenantLineConfig | null>; // null は競合 (書き込み直前に他の更新が割り込んだ) を意味する
  // テナントの LINE 連携設定を削除する (tenantId スコープで他テナントは no-op)
  delete(tenantId: string): Promise<void>;
}
