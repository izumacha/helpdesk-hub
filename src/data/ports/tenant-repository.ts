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
  // テナントの動作モード (lite | pro) を更新する。
  // id はセッション由来の tenantId のみを渡す契約 (リクエスト入力から注入しないこと = クロステナント防止)。
  // 監査で発見したギャップ対応: 'pro' への切替時は expectedPlanIn を渡し、その配列に現在の
  // 契約プラン (subscriptionPlan) が含まれる場合のみ更新する原子的な更新 (CAS) にする。
  // 0 件更新なら false を返す。これにより「プラン確認 (isProModeAllowed) → 書き込み」の間に
  // Stripe Webhook 由来の自動ダウングレード (applyPlanChange の updateMode(id, 'lite')) が
  // 割り込んでも、古いプラン判定のまま Pro モードへ上書きされることを防ぐ。
  // 'pro' への切替オーバーロードは expectedPlanIn を必須にしている (/code-review ultra 指摘対応:
  // 省略可能な第 3 引数のままだと、将来 'pro' へ切り替える呼び出しが増えたときに渡し忘れても
  // コンパイルが通り、この CAS 保護だけが黙って無効化された無条件更新に戻ってしまうため、
  // オーバーロードで型レベルの強制にした)。'lite' への切替は常にどのプランでも許可されるため
  // expectedPlanIn を取らない (常に無条件更新で true を返す)。
  updateMode(id: string, mode: 'lite'): Promise<boolean>;
  updateMode(id: string, mode: 'pro', expectedPlanIn: SubscriptionPlan[]): Promise<boolean>;
  // メール取り込み用の inboundToken を (再)発行する。マイグレーション前から存在し未発行のままの
  // テナントへの初回発行、および漏洩・スパム混入時の再発行 (ローテーション) の両方に使う。
  // id はセッション由来の tenantId のみを渡す契約 (クロステナント防止)
  updateInboundToken(id: string, token: string): Promise<Tenant>;
  // Phase 4: 外部通知チャネル (Slack / Teams / Chatwork) の設定をまとめて更新する。
  // 渡したフィールドだけ更新し、undefined のフィールドは現状維持する (部分更新)。
  // null を渡すと該当チャネルの通知を無効化する (設定画面の「削除」操作に対応)。
  // id はセッション由来の tenantId のみを渡すこと (クロステナント変更防止)。
  // フォローアップ (監査で発見したギャップ): 読み取り→検証→無条件書き込みの check-then-act
  // (TOCTOU) だった。updateStatus/updateContent (Faq)・updateStatus/markEscalated (Ticket) と
  // 同じ CAS (compare-and-swap) パターンを適用する。expected を省略した場合は従来どおり
  // 無条件の部分更新 (undefined = skip) のままとし、Promise<boolean> の戻り値だけ「更新できたか」
  // を表す (呼び出し元が対象行を読んでいない内部用途向けの互換パスとして残す)。
  // expected を渡した場合、読み取り時点の 4 チャネル値と現在値が一致するときだけ更新する
  // (一致しない = 他の管理者による並行更新と競合。0 件更新なら false を返す)。
  updateNotificationChannels(
    id: string,
    data: {
      slackWebhookUrl?: string | null; // Slack Incoming Webhook URL
      teamsWebhookUrl?: string | null; // Teams Incoming Webhook URL
      chatworkApiToken?: string | null; // Chatwork API トークン
      chatworkRoomId?: string | null; // Chatwork ルーム ID
    },
    expected?: {
      slackWebhookUrl: string | null; // 読み取り時点の Slack Webhook URL
      teamsWebhookUrl: string | null; // 読み取り時点の Teams Webhook URL
      chatworkApiToken: string | null; // 読み取り時点の Chatwork API トークン
      chatworkRoomId: string | null; // 読み取り時点の Chatwork ルーム ID
    },
  ): Promise<boolean>;
  // Phase 4 課金: Stripe Billing の連携情報をまとめて更新する。
  // Stripe Webhook 受信時に呼び出し、Customer ID・Subscription ID・状態・プランを一括更新。
  // id はセッション/Webhook由来のテナント ID のみを渡すこと (クロステナント更新防止)。
  //
  // フォローアップ (監査で発見したギャップ 2026-07-20): Stripe は Webhook イベントの配信順序を
  // 保証しない (公式ドキュメント記載。リトライ・ネットワーク遅延で古いイベントが新しいイベントより
  // 後に届きうる)。eventCreatedAt (Stripe イベント自体の発生時刻 = event.created) を渡すと、
  // 保存済みの直近処理イベント時刻より新しい (または未処理) ときだけ適用する CAS になる。
  // updateMode/updateNotificationChannels と同じ「0 件更新なら false」の boolean 契約。
  // eventCreatedAt を省略した場合は順序チェックをせず常に適用する (既存の契約テスト等、
  // 順序保証が不要な呼び出し元との後方互換のため)
  updateStripeSubscription(
    id: string,
    data: {
      stripeCustomerId?: string | null;
      stripeSubscriptionId?: string | null;
      stripeSubscriptionStatus?: string | null;
      subscriptionPlan?: SubscriptionPlan;
    },
    eventCreatedAt?: Date,
  ): Promise<boolean>;
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
  // フォローアップ (2026-07-21): 隔離メール発生を admin に知らせる通知 (NotificationType.quarantined)
  // の送信間隔を空けるための原子的なゲート。「quarantineNotifiedAt が null、または
  // at - intervalMs より前 (=間隔を空けて十分に時間が経っている)」ときだけ quarantineNotifiedAt を
  // at に更新して true を返す (このリクエストが通知を送る権利を得た)。それ以外 (直近に別の
  // リクエストが既に更新済み) は false を返し、呼び出し側は通知を送らない。
  // 読み取り→判定→書き込みの check-then-act ではなく単一の原子的な updateMany (updateMode 等と
  // 同じ CAS パターン) にすることで、短時間に大量の隔離が発生しても重複送信のレースを防ぐ。
  // id はセッション/内部呼び出し由来の tenantId のみを渡すこと
  updateQuarantineNotifiedAt(id: string, at: Date, intervalMs: number): Promise<boolean>;
}
