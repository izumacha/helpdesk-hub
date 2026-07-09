// ドメイン層の Tenant 型とテナントモード・課金プラン型・外部通知チャネルキー型を参照
import type { OutboundChannelKey, SubscriptionPlan, Tenant, TenantMode } from '@/domain/types';

// Tenant 操作の契約 (port)。取得系に加え、Lite/Pro モード切替の更新系を提供する
export interface TenantRepository {
  findById(id: string): Promise<Tenant | null>; // 主キー検索
  findDefault(): Promise<Tenant | null>; // ピボット途中で使う 'default-tenant' を取得する便利メソッド
  // メール取り込み (Phase 2) 用: 転送アドレスのローカルパート (inboundToken) でテナントを引く。
  // Webhook は認証セッションを持たないため、この経路だけはトークン一致でテナントを特定する。
  findByInboundToken(token: string): Promise<Tenant | null>;
  // 新規テナント (組織) を 1 件作成する (運用者向けのテナント作成フォームで使う)。
  // mode 未指定なら SMB 既定の lite で作る。inboundToken はメール取り込みアドレスのローカルパート
  // (呼び出し側で生成して渡す。未指定なら null = 取り込み無効で作る)。
  create(input: {
    name: string;
    industry?: string | null;
    mode?: TenantMode;
    inboundToken?: string | null;
    trialEndsAt?: Date | null; // §7.2 Free trial の終了日時 (未指定なら null = トライアル無し)
  }): Promise<Tenant>;
  // テナントの動作モード (lite | pro) を更新し、更新後の Tenant を返す
  // id はセッション由来の tenantId のみを渡す契約 (リクエスト入力から注入しないこと = クロステナント防止)
  updateMode(id: string, mode: TenantMode): Promise<Tenant>;
  // メール取り込み用の inboundToken を (再)発行する。マイグレーション前から存在し未発行のままの
  // テナントへの初回発行、および漏洩・スパム混入時の再発行 (ローテーション) の両方に使う。
  // id はセッション由来の tenantId のみを渡す契約 (クロステナント防止)
  updateInboundToken(id: string, token: string): Promise<Tenant>;
  // Phase 4: 外部通知チャネル (Slack / Teams / Chatwork) の設定をまとめて更新する。
  // 渡したフィールドだけ更新し、undefined のフィールドは現状維持する (部分更新)。
  // null を渡すと該当チャネルの通知を無効化する (設定画面の「削除」操作に対応)。
  // id はセッション由来の tenantId のみを渡すこと (クロステナント変更防止)。
  updateNotificationChannels(
    id: string,
    data: {
      slackWebhookUrl?: string | null; // Slack Incoming Webhook URL
      teamsWebhookUrl?: string | null; // Teams Incoming Webhook URL
      chatworkApiToken?: string | null; // Chatwork API トークン
      chatworkRoomId?: string | null; // Chatwork ルーム ID
    },
  ): Promise<Tenant>;
  // Phase 4 課金: Stripe Billing の連携情報をまとめて更新する。
  // Stripe Webhook 受信時に呼び出し、Customer ID・Subscription ID・状態・プランを一括更新。
  // id はセッション/Webhook由来のテナント ID のみを渡すこと (クロステナント更新防止)。
  updateStripeSubscription(
    id: string,
    data: {
      stripeCustomerId?: string | null;
      stripeSubscriptionId?: string | null;
      stripeSubscriptionStatus?: string | null;
      subscriptionPlan?: SubscriptionPlan;
    },
  ): Promise<Tenant>;
  // §7.2 Free trial 終了リマインダー用: 契約プランが free で、かつ trialEndsAt が now より
  // 未来 (=トライアル進行中) のテナントを limit 件までを上限に返す (§8 一覧取得は必ず上限を
  // 持たせる)。呼び出し側 (定期実行のリマインダー処理) が各テナントの残り日数からリマインド
  // 要否を判定する (このメソッド自体はリマインダー送信要否を判定しない)
  listActiveTrials(now: Date, limit: number): Promise<Tenant[]>;
  // §7.2.1 Free trial 終了リマインダーの冪等化フラグを更新する。cron の手動再実行 (workflow_dispatch)・
  // 遅延・欠落があっても同じマイルストーン (5 | 1) を二重送信しないよう、送信成功後に呼ぶ。
  // id はセッション/cron由来のテナント ID のみを渡すこと (クロステナント更新防止)
  updateTrialReminderLastSent(id: string, daysBefore: number): Promise<Tenant>;
  // Phase 4: 外部通知チャネル (Slack/Teams/Chatwork) 1 件の送信結果を記録する。
  // failure に { message, at } を渡すと直近の失敗として記録し、null を渡すと直近の失敗記録を
  // クリアする (次の送信が成功したとき呼ぶ)。履歴は持たず直近 1 件のみを保持する設計 (§6 一元管理)。
  // id はセッション/内部呼び出し由来の tenantId のみを渡すこと (クロステナント更新防止)
  recordOutboundChannelResult(
    id: string,
    channel: OutboundChannelKey,
    failure: { message: string; at: Date } | null,
  ): Promise<Tenant>;
}
