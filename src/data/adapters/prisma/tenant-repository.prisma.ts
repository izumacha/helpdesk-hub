// Tenant リポジトリの契約 (port)
import type { TenantRepository } from '@/data/ports/tenant-repository';
// 課金プラン型 (Stripe 課金プランの型チェック)
import type { SubscriptionPlan } from '@/domain/types';
// ドメイン型
import type { Tenant } from '@/domain/types';
// Prisma の Tenant 行型
import type { Prisma } from '@/generated/prisma';
// Prisma クライアント/トランザクション共通型
import type { PrismaLike } from './types';

// Prisma の Tenant 行 (include なし)
type TenantRow = Prisma.TenantGetPayload<Record<string, never>>;

// Prisma 行 → ドメイン型 Tenant に変換
function toTenant(row: TenantRow): Tenant {
  // 必要なフィールドだけを詰め替えて返す (余計なフィールドは付与しない)
  return {
    id: row.id,
    name: row.name,
    mode: row.mode,
    industry: row.industry,
    inboundToken: row.inboundToken, // メール取り込みアドレスのローカルパート (未発行なら null)
    // Phase 4: 外部通知チャネル設定 (null なら各チャネル無効)
    slackWebhookUrl: row.slackWebhookUrl, // Slack Incoming Webhook URL
    teamsWebhookUrl: row.teamsWebhookUrl, // Teams Incoming Webhook URL
    chatworkApiToken: row.chatworkApiToken, // Chatwork API トークン
    chatworkRoomId: row.chatworkRoomId, // Chatwork ルーム ID
    // Phase 4 課金: Stripe Billing 連携フィールド
    subscriptionPlan: row.subscriptionPlan, // 現在の課金プラン (free | standard | pro)
    stripeCustomerId: row.stripeCustomerId, // Stripe Customer ID (null なら未登録)
    stripeSubscriptionId: row.stripeSubscriptionId, // Stripe Subscription ID (null なら未契約)
    stripeSubscriptionStatus: row.stripeSubscriptionStatus, // Stripe の subscription.status
    trialEndsAt: row.trialEndsAt, // §7.2 Free trial 終了日時 (対象外/終了済みなら null)
    createdAt: row.createdAt,
  };
}

// Prisma クライアントを使った Tenant リポジトリを生成する関数
export function makeTenantRepo(db: PrismaLike): TenantRepository {
  return {
    // ID で 1 件取得 (見つからなければ null)
    async findById(id) {
      const row = await db.tenant.findUnique({ where: { id } });
      return row ? toTenant(row) : null;
    },

    // バックフィル用のデフォルト Tenant ('default-tenant') を取得
    async findDefault() {
      const row = await db.tenant.findUnique({ where: { id: 'default-tenant' } });
      return row ? toTenant(row) : null;
    },

    // メール取り込み用トークン (転送アドレスのローカルパート) でテナントを引く
    async findByInboundToken(token) {
      // @unique 列なので findUnique で 1 件特定できる (見つからなければ null)
      const row = await db.tenant.findUnique({ where: { inboundToken: token } });
      return row ? toTenant(row) : null;
    },

    // 新規テナント (組織) を 1 件作成する (運用者向けのテナント作成フォーム用)
    async create(input) {
      // Prisma 経由で行を作成。mode 未指定なら SMB 既定の lite で作る
      const row = await db.tenant.create({
        data: {
          name: input.name, // 組織名
          industry: input.industry ?? null, // 業種テンプレ識別子 (任意)
          mode: input.mode ?? 'lite', // 動作モード (既定 lite)
          inboundToken: input.inboundToken ?? null, // メール取り込みアドレスのローカルパート (任意)
          trialEndsAt: input.trialEndsAt ?? null, // §7.2 Free trial 終了日時 (任意)
        },
      });
      // 作成行をドメイン型に変換して返す
      return toTenant(row);
    },

    // テナントの動作モード (lite | pro) を更新し、更新後の行をドメイン型で返す
    async updateMode(id, mode) {
      // 主キー (tenantId) で対象テナントを特定し mode 列のみ更新する
      const row = await db.tenant.update({ where: { id }, data: { mode } });
      // 更新後の行をドメイン型に詰め替えて返す
      return toTenant(row);
    },

    // メール取り込み用の inboundToken を (再)発行する。主キーで対象テナントを特定し列のみ更新する
    async updateInboundToken(id, token) {
      const row = await db.tenant.update({ where: { id }, data: { inboundToken: token } });
      // 更新後の行をドメイン型に詰め替えて返す
      return toTenant(row);
    },

    // Phase 4: 外部通知チャネル (Slack / Teams / Chatwork) の設定を部分更新する (null で無効化)
    async updateNotificationChannels(id, data) {
      // 主キーで対象テナントを特定する。undefined のフィールドは Prisma が skip するため現状維持
      const row = await db.tenant.update({
        where: { id },
        data: {
          slackWebhookUrl: data.slackWebhookUrl, // Slack Webhook URL (undefined ならスキップ)
          teamsWebhookUrl: data.teamsWebhookUrl, // Teams Webhook URL (undefined ならスキップ)
          chatworkApiToken: data.chatworkApiToken, // Chatwork トークン (undefined ならスキップ)
          chatworkRoomId: data.chatworkRoomId, // Chatwork ルーム ID (undefined ならスキップ)
        },
      });
      // 更新後の行をドメイン型に詰め替えて返す
      return toTenant(row);
    },

    // Phase 4 課金: Stripe の連携情報 (Customer ID / Subscription ID / 状態 / プラン) を一括更新
    async updateStripeSubscription(id, data) {
      // undefined 以外のフィールドのみ更新する (Prisma は undefined を無視する)
      const row = await db.tenant.update({
        where: { id },
        data: {
          // undefined なら Prisma が skip するため、明示的に条件分岐しない
          stripeCustomerId: data.stripeCustomerId,
          stripeSubscriptionId: data.stripeSubscriptionId,
          stripeSubscriptionStatus: data.stripeSubscriptionStatus,
          // subscriptionPlan は SubscriptionPlan 型として型チェックされた値のみ受け付ける
          subscriptionPlan: data.subscriptionPlan as SubscriptionPlan | undefined,
        },
      });
      // 更新後の行をドメイン型に詰め替えて返す
      return toTenant(row);
    },

    // §7.2 Free trial 終了リマインダー用: free プランかつトライアル進行中 (trialEndsAt > now)
    // のテナントを limit 件までを上限に返す
    async listActiveTrials(now, limit) {
      const rows = await db.tenant.findMany({
        where: { subscriptionPlan: 'free', trialEndsAt: { gt: now } },
        take: limit, // §8 一覧取得は必ず上限を持たせる
        orderBy: { trialEndsAt: 'asc' }, // 終了が近い順 (デバッグ・ログ確認時の見やすさのため)
      });
      // 各行をドメイン型に詰め替えて返す
      return rows.map(toTenant);
    },
  };
}
