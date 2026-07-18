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
        teamsWebhookUrl: null, // 新規テナントは Teams 通知未設定 (null = 無効)
        chatworkApiToken: null, // 新規テナントは Chatwork トークン未設定 (null = 無効)
        chatworkRoomId: null, // 新規テナントは Chatwork ルーム未設定 (null = 無効)
        // Phase 4 課金: 新規テナントは無料プラン・Stripe 未連携で初期化
        subscriptionPlan: 'free',
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        stripeSubscriptionStatus: null,
        trialEndsAt: input.trialEndsAt ?? null, // §7.2 Free trial 終了日時 (任意)
        createdAt: new Date(),
      };
      // ストアの Map に登録
      store.tenants.set(tenant.id, tenant);
      // 防御的コピーを返す
      return { ...tenant };
    },

    // テナントの動作モード (lite | pro) を更新する (Prisma アダプタの updateMany と同じ CAS 契約)。
    // 'pro' への切替時のみ expectedPlanIn で現在の subscriptionPlan を検証する
    async updateMode(id, mode, expectedPlanIn) {
      // 対象テナントを Map から取得 (存在しなければ Prisma の updateMany と同様に false)
      const t = store.tenants.get(id);
      if (!t) return false;
      // 'pro' への切替かつ expectedPlanIn 指定時のみ、現在のプランが許可リストに含まれるか検証する
      if (mode === 'pro' && expectedPlanIn && !expectedPlanIn.includes(t.subscriptionPlan)) {
        // プランが許可リストに含まれない (競合、または元々不許可) — 更新せず false
        return false;
      }
      // mode だけ差し替えた新しいオブジェクトを作り Map に書き戻す
      store.tenants.set(id, { ...t, mode });
      return true;
    },

    // メール取り込み用の inboundToken を (再)発行する
    async updateInboundToken(id, token) {
      // 対象テナントを Map から取得 (存在しなければエラー)
      const t = store.tenants.get(id);
      if (!t) throw new Error('テナントが見つかりません');
      // inboundToken だけ差し替えた新しいオブジェクトを作り Map に書き戻す
      const updated = { ...t, inboundToken: token };
      store.tenants.set(id, updated);
      // 防御的コピーを返す
      return { ...updated };
    },

    // Phase 4: 外部通知チャネル (Slack / Teams / Chatwork) の設定を部分更新する (null で無効化)
    async updateNotificationChannels(id, data) {
      // 対象テナントを Map から取得 (存在しなければエラー)
      const t = store.tenants.get(id);
      if (!t) throw new Error('テナントが見つかりません');
      // 渡されたフィールドだけ差し替える (undefined なら既存値を維持する)
      const updated: Tenant = {
        ...t,
        slackWebhookUrl:
          data.slackWebhookUrl !== undefined ? data.slackWebhookUrl : t.slackWebhookUrl,
        teamsWebhookUrl:
          data.teamsWebhookUrl !== undefined ? data.teamsWebhookUrl : t.teamsWebhookUrl,
        chatworkApiToken:
          data.chatworkApiToken !== undefined ? data.chatworkApiToken : t.chatworkApiToken,
        chatworkRoomId: data.chatworkRoomId !== undefined ? data.chatworkRoomId : t.chatworkRoomId,
      };
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

    // §7.2 Free trial 終了リマインダー用: free プランかつトライアル進行中 (trialEndsAt > now)
    // のテナントを limit 件までを上限に、終了が近い順で返す
    async listActiveTrials(now, limit) {
      const matches: Tenant[] = [];
      // 全テナントを走査し条件に合うものだけ集める (テスト規模なら線形で十分)
      for (const t of store.tenants.values()) {
        if (
          t.subscriptionPlan === 'free' &&
          t.trialEndsAt &&
          t.trialEndsAt.getTime() > now.getTime()
        ) {
          matches.push({ ...t }); // 防御的コピー
        }
      }
      // 終了が近い順 (trialEndsAt 昇順) に並べ替える
      matches.sort((a, b) => a.trialEndsAt!.getTime() - b.trialEndsAt!.getTime());
      // 上限件数まで切り詰めて返す
      return matches.slice(0, limit);
    },

    // §7.2.1 Free trial 終了リマインダーの冪等化フラグを更新する
    async updateTrialReminderLastSent(id, daysBefore) {
      // 対象テナントを Map から取得 (存在しなければエラー)
      const t = store.tenants.get(id);
      if (!t) throw new Error('テナントが見つかりません');
      // フラグだけ差し替えた新しいオブジェクトを作り Map に書き戻す
      const updated = { ...t, trialReminderLastSentDaysBefore: daysBefore };
      store.tenants.set(id, updated);
      // 防御的コピーを返す
      return { ...updated };
    },

    // Phase 4: 外部通知チャネル 1 件の送信結果を記録する (失敗時は日時+メッセージ、成功時は null でクリア)
    async recordOutboundChannelResult(id, channel, failure) {
      // 対象テナントを Map から取得 (存在しなければエラー)
      const t = store.tenants.get(id);
      if (!t) throw new Error('テナントが見つかりません');
      // 失敗時は日時とメッセージを、成功 (クリア) 時は両方 null にする
      const at = failure ? failure.at : null;
      const message = failure ? failure.message : null;
      // 更新後のテナント (チャネルに応じて書き換えるフィールドが変わる)
      let updated: Tenant;
      // チャネルキーで分岐する (3 種類のみなので switch で列挙する)
      switch (channel) {
        case 'slack':
          // Slack 用の 2 フィールドだけを差し替えた新しいオブジェクトを作る
          updated = { ...t, slackLastFailureAt: at, slackLastFailureMessage: message };
          break; // 他のケースに落ちないよう抜ける
        case 'teams':
          // Teams 用の 2 フィールドだけを差し替えた新しいオブジェクトを作る
          updated = { ...t, teamsLastFailureAt: at, teamsLastFailureMessage: message };
          break; // 他のケースに落ちないよう抜ける
        case 'chatwork':
          // Chatwork 用の 2 フィールドだけを差し替えた新しいオブジェクトを作る
          updated = { ...t, chatworkLastFailureAt: at, chatworkLastFailureMessage: message };
          break; // 他のケースに落ちないよう抜ける
      }
      store.tenants.set(id, updated);
      // 防御的コピーを返す
      return { ...updated };
    },
  };
}
