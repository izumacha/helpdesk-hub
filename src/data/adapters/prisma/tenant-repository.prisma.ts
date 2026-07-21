// Tenant リポジトリの契約 (port)
import type { TenantRepository } from '@/data/ports/tenant-repository';
// 課金プラン型 (Stripe 課金プランの型チェック)
import type { SubscriptionPlan } from '@/domain/types';
// ドメイン型・テナントモード型
import type { Tenant, TenantMode } from '@/domain/types';
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
    trialReminderLastSentDaysBefore: row.trialReminderLastSentDaysBefore, // §7.2.1 冪等化フラグ
    // 外部通知チャネルの直近送信失敗 (チャネルごとに 1 件のみ。成功後は null)
    slackLastFailureAt: row.slackLastFailureAt,
    slackLastFailureMessage: row.slackLastFailureMessage,
    teamsLastFailureAt: row.teamsLastFailureAt,
    teamsLastFailureMessage: row.teamsLastFailureMessage,
    chatworkLastFailureAt: row.chatworkLastFailureAt,
    chatworkLastFailureMessage: row.chatworkLastFailureMessage,
    // フォローアップ (監査で発見したギャップ 2026-07-20): Stripe Webhook 配信順序 CAS 用の
    // 直近処理イベント時刻 (未処理なら null)
    stripeEventProcessedAt: row.stripeEventProcessedAt,
    // フォローアップ (2026-07-21): 隔離メール通知の送信間隔を空けるための直近送信時刻 (未送信は null)
    quarantineNotifiedAt: row.quarantineNotifiedAt,
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

    // テナントの動作モード (lite | pro) を更新する。
    // 'pro' への切替時のみ expectedPlanIn を where 条件に含めた原子的な更新 (CAS) にする
    // (Stripe Webhook 由来の自動ダウングレードとの TOCTOU 競合防止。ポートのコメント参照)。
    // 'lite' への切替や expectedPlanIn 省略時は無条件更新。updateMany の対象は主キー (id) のみ
    // (または + subscriptionPlan) のため、他テナントへ波及する余地はない
    // port のオーバーロード (mode:'lite' は expectedPlanIn 無し / mode:'pro' は必須) を単一の
    // 実装関数で満たすため、パラメータ型を明示する (未annotationだと最初のオーバーロードの
    // シグネチャだけが contextual typing で採用され、'pro' 呼び出しが型エラーになるため)
    async updateMode(
      id: string,
      mode: TenantMode,
      expectedPlanIn?: SubscriptionPlan[],
    ): Promise<boolean> {
      // 'pro' への切替かつ expectedPlanIn 指定時のみ、現在のプランも where 条件に含める
      // (それ以外は主キー (id) だけで絞り込む無条件更新)
      const where: Prisma.TenantWhereInput =
        mode === 'pro' && expectedPlanIn
          ? { id, subscriptionPlan: { in: expectedPlanIn } }
          : { id };
      // 条件に一致する行だけを更新する (0 件・1 件のどちらもあり得る updateMany)
      const result = await db.tenant.updateMany({ where, data: { mode } });
      // 1 件以上更新できたか (0 件ならプラン不一致による競合、または対象不在) を返す
      return result.count > 0;
    },

    // メール取り込み用の inboundToken を (再)発行する。主キーで対象テナントを特定し列のみ更新する
    async updateInboundToken(id, token) {
      const row = await db.tenant.update({ where: { id }, data: { inboundToken: token } });
      // 更新後の行をドメイン型に詰め替えて返す
      return toTenant(row);
    },

    // Phase 4: 外部通知チャネル (Slack / Teams / Chatwork) の設定を部分更新する (null で無効化)。
    // フォローアップ (監査で発見したギャップ): expected が渡された場合のみ、読み取り時点の
    // 4 チャネル値を where 条件にも含めた原子的な updateMany (CAS) にする。updateStatus (Faq/Ticket)
    // と同じパターンで、0 件更新 (他の管理者による並行更新との競合) なら false を返す
    async updateNotificationChannels(id, data, expected) {
      // expected 指定時のみ、読み取り時点の値を where 条件に追加する (未指定なら主キーのみ)
      const where: Prisma.TenantWhereInput = expected
        ? {
            id,
            slackWebhookUrl: expected.slackWebhookUrl,
            teamsWebhookUrl: expected.teamsWebhookUrl,
            chatworkApiToken: expected.chatworkApiToken,
            chatworkRoomId: expected.chatworkRoomId,
          }
        : { id };
      // 条件に一致する行だけを更新する (0 件・1 件のどちらもあり得る updateMany)
      const result = await db.tenant.updateMany({
        where,
        data: {
          slackWebhookUrl: data.slackWebhookUrl, // Slack Webhook URL (undefined ならスキップ)
          teamsWebhookUrl: data.teamsWebhookUrl, // Teams Webhook URL (undefined ならスキップ)
          chatworkApiToken: data.chatworkApiToken, // Chatwork トークン (undefined ならスキップ)
          chatworkRoomId: data.chatworkRoomId, // Chatwork ルーム ID (undefined ならスキップ)
        },
      });
      // 1 件以上更新できたか (0 件なら競合または対象不在) を返す
      return result.count > 0;
    },

    // Phase 4 課金: Stripe の連携情報 (Customer ID / Subscription ID / 状態 / プラン) を一括更新。
    // フォローアップ (監査で発見したギャップ 2026-07-20): eventCreatedAt が渡された場合のみ、
    // 「保存済みの stripeEventProcessedAt が null、またはそれ以下 (=今回のイベントの方が新しい
    // か同時刻)」を where 条件に含めた原子的な updateMany (CAS) にする。Stripe Webhook の配信
    // 順序は保証されないため、これが無いと古いイベントが後から届いて新しい状態を巻き戻しうる
    async updateStripeSubscription(id, data, eventCreatedAt) {
      // eventCreatedAt 省略時は主キーのみで絞り込む (順序チェックなし。従来どおりの無条件更新)
      const where: Prisma.TenantWhereInput = eventCreatedAt
        ? {
            id,
            OR: [
              { stripeEventProcessedAt: null }, // まだ一度も Stripe イベントを適用していない
              { stripeEventProcessedAt: { lte: eventCreatedAt } }, // 今回のイベントの方が新しいか同時刻
            ],
          }
        : { id };
      // 条件に一致する行だけを更新する (0 件・1 件のどちらもあり得る updateMany)
      const result = await db.tenant.updateMany({
        where,
        data: {
          // undefined なら Prisma が skip するため、明示的に条件分岐しない
          stripeCustomerId: data.stripeCustomerId,
          stripeSubscriptionId: data.stripeSubscriptionId,
          stripeSubscriptionStatus: data.stripeSubscriptionStatus,
          // subscriptionPlan は SubscriptionPlan 型として型チェックされた値のみ受け付ける
          subscriptionPlan: data.subscriptionPlan as SubscriptionPlan | undefined,
          // eventCreatedAt を渡された場合のみ、直近処理イベント時刻を更新する
          ...(eventCreatedAt ? { stripeEventProcessedAt: eventCreatedAt } : {}),
        },
      });
      // 1 件以上更新できたか (0 件なら古いイベントとして無視された、または対象不在) を返す
      return result.count > 0;
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

    // §7.2.1 Free trial 終了リマインダーの冪等化フラグを更新する。cron の手動再実行・遅延・欠落が
    // あっても同じマイルストーンを二重送信しないよう、送信成功後にこの値を書き込む
    async updateTrialReminderLastSent(id, daysBefore) {
      const row = await db.tenant.update({
        where: { id },
        data: { trialReminderLastSentDaysBefore: daysBefore },
      });
      // 更新後の行をドメイン型に詰め替えて返す
      return toTenant(row);
    },

    // Phase 4: 外部通知チャネル 1 件の送信結果を記録する (失敗時は日時+メッセージ、成功時は null でクリア)。
    // チャネルごとにカラムが分かれているため switch で明示的に振り分ける (動的キーで any を使わない)
    async recordOutboundChannelResult(id, channel, failure) {
      // 失敗時は日時とメッセージを、成功 (クリア) 時は両方 null を書き込む
      const at = failure ? failure.at : null;
      const message = failure ? failure.message : null;
      // Prisma の更新データ (チャネルに応じて書き込むカラムが変わる)
      let data: Prisma.TenantUpdateInput;
      // チャネルキーで分岐する (3 種類のみなので switch で列挙する)
      switch (channel) {
        case 'slack':
          // Slack 用の 2 カラムだけを更新対象にする
          data = { slackLastFailureAt: at, slackLastFailureMessage: message };
          break; // 他のケースに落ちないよう抜ける
        case 'teams':
          // Teams 用の 2 カラムだけを更新対象にする
          data = { teamsLastFailureAt: at, teamsLastFailureMessage: message };
          break; // 他のケースに落ちないよう抜ける
        case 'chatwork':
          // Chatwork 用の 2 カラムだけを更新対象にする
          data = { chatworkLastFailureAt: at, chatworkLastFailureMessage: message };
          break; // 他のケースに落ちないよう抜ける
      }
      const row = await db.tenant.update({ where: { id }, data });
      // 更新後の行をドメイン型に詰め替えて返す
      return toTenant(row);
    },

    // フォローアップ (2026-07-21): 隔離メール通知の送信間隔を空けるための原子的なゲート。
    // quarantineNotifiedAt が null、または (at - intervalMs) より前の行だけを対象に更新する
    // updateMany (updateMode 等と同じ CAS パターン)。1 件以上更新できた = このリクエストが
    // 通知を送る権利を得たことを意味する
    async updateQuarantineNotifiedAt(id, at, intervalMs) {
      const threshold = new Date(at.getTime() - intervalMs);
      const result = await db.tenant.updateMany({
        where: {
          id,
          OR: [{ quarantineNotifiedAt: null }, { quarantineNotifiedAt: { lt: threshold } }],
        },
        data: { quarantineNotifiedAt: at },
      });
      return result.count > 0;
    },
  };
}
