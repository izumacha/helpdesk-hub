// Tenant リポジトリの契約 (port)
import type { TenantRepository } from '@/data/ports/tenant-repository';
// ドメイン型
import type { Tenant } from '@/domain/types';
// メモリストア型と ID 生成関数
import { nextId, type Store } from './store';

// メモリストアを使った Tenant リポジトリを生成する関数 (テスト用)
export function makeTenantRepo(store: Store): TenantRepository {
  return {
    // ID で 1 件取得 (見つからなければ null)
    async findById(id) {
      const t = store.tenants.get(id); // Map から取得
      return t ? { ...t } : null; // 防御的コピーを返す
    },

    // 'default-tenant' を取得
    async findDefault() {
      const t = store.tenants.get('default-tenant');
      return t ? { ...t } : null;
    },

    // メール取り込み用トークン (転送アドレスのローカルパート) でテナントを引く
    async findByInboundToken(token) {
      // 全テナントを走査し inboundToken が一致する最初の 1 件を返す (テスト規模なら線形で十分)
      for (const t of store.tenants.values()) {
        if (t.inboundToken === token) return { ...t }; // 防御的コピーを返す
      }
      // 一致なしは null
      return null;
    },

    // 新規テナント (組織) を 1 件作成する (テナント作成フォーム用)
    async create(input) {
      // 新しいテナント行を組み立てる (mode 未指定なら lite)
      const tenant: Tenant = {
        id: nextId(store, 'tnt'), // 'tnt_...' 形式の一意 ID
        name: input.name,
        mode: input.mode ?? 'lite',
        industry: input.industry ?? null,
        inboundToken: input.inboundToken ?? null, // メール取り込みアドレスのローカルパート (任意)
        slackWebhookUrl: null, // 新規テナントは Slack 通知未設定 (null = 無効)
        // Phase 4 課金: 新規テナントは無料プラン・Stripe 未連携で初期化
        subscriptionPlan: 'free',
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        stripeSubscriptionStatus: null,
        createdAt: new Date(),
      };
      // ストアの Map に登録
      store.tenants.set(tenant.id, tenant);
      // 防御的コピーを返す
      return { ...tenant };
    },

    // テナントの動作モード (lite | pro) を更新し、更新後の Tenant を返す
    async updateMode(id, mode) {
      // 対象テナントを Map から取得 (存在しなければ Prisma の update と同様にエラー)
      const t = store.tenants.get(id);
      if (!t) throw new Error('テナントが見つかりません');
      // mode だけ差し替えた新しいオブジェクトを作り Map に書き戻す
      const updated = { ...t, mode };
      store.tenants.set(id, updated);
      // 防御的コピーを返す (呼び出し側で破壊されないように)
      return { ...updated };
    },

    // Phase 4: Slack/Teams Incoming Webhook URL を更新する (null で無効化)
    async updateSlackWebhookUrl(id, url) {
      // 対象テナントを Map から取得 (存在しなければエラー)
      const t = store.tenants.get(id);
      if (!t) throw new Error('テナントが見つかりません');
      // slackWebhookUrl だけ差し替えた新しいオブジェクトを作り Map に書き戻す
      const updated = { ...t, slackWebhookUrl: url };
      store.tenants.set(id, updated);
      // 防御的コピーを返す
      return { ...updated };
    },

    // Phase 4 課金: Stripe の連携情報を一括更新する (Webhook 受信時に呼ぶ)
    async updateStripeSubscription(id, data) {
      // 対象テナントを Map から取得 (存在しなければエラー)
      const t = store.tenants.get(id);
      if (!t) throw new Error('テナントが見つかりません');
      // 渡されたフィールドだけ差し替える (undefined はスキップ)
      const updated: Tenant = {
        ...t,
        // undefined でなければ上書きし、undefined なら既存値を維持する
        stripeCustomerId:
          data.stripeCustomerId !== undefined ? data.stripeCustomerId : t.stripeCustomerId,
        stripeSubscriptionId:
          data.stripeSubscriptionId !== undefined
            ? data.stripeSubscriptionId
            : t.stripeSubscriptionId,
        stripeSubscriptionStatus:
          data.stripeSubscriptionStatus !== undefined
            ? data.stripeSubscriptionStatus
            : t.stripeSubscriptionStatus,
        subscriptionPlan: data.subscriptionPlan ?? t.subscriptionPlan,
      };
      store.tenants.set(id, updated);
      // 防御的コピーを返す
      return { ...updated };
    },
  };
}
