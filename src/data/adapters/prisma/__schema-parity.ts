// 目的: ドメイン型 (@/domain/types) と Prisma 生成 enum (@/generated/prisma) の
//       「値のズレ」をビルド時 (npm run typecheck) に検出する番人ファイル。
// この層 (src/data/adapters/prisma/**) だけが @/generated/prisma を参照してよい
// (ESLint の no-restricted-imports でも例外として許可している)。
// 実行時には何もしないが、typecheck の対象に入るため、ドメイン型と schema の
// どちらか片方だけを変更すると下の代入が型エラーになり CI が落ちる = ドリフト検知。

// Prisma スキーマから生成された enum 型を P〜 という別名で読み込む (比較用の片側)
import type {
  Role as PRole, // 権限 enum (生成側)
  TicketStatus as PStatus, // チケット状態 enum (生成側)
  Priority as PPriority, // 優先度 enum (生成側)
  HistoryField as PHistory, // 履歴項目 enum (生成側)
  FaqStatus as PFaqStatus, // FAQ 状態 enum (生成側)
  NotificationType as PNotificationType, // 通知種別 enum (生成側)
  TenantMode as PTenantMode, // テナント動作モード enum (生成側)
  SubscriptionPlan as PSubscriptionPlan, // 課金プラン enum (生成側 / Phase 4)
  SettingsAuditAction as PSettingsAuditAction, // 設定変更監査の操作種別 enum (生成側)
  AuthAuditEvent as PAuthAuditEvent, // 認証イベント監査の種別 enum (生成側)
  QuarantineReason as PQuarantineReason, // 取り込み隔離の理由 enum (生成側)
  QuarantineChannel as PQuarantineChannel, // 隔離記録の発生元チャネル enum (生成側)
  MagicLinkPurpose as PMagicLinkPurpose, // マジックリンクトークンの用途 enum (生成側)
} from '@/generated/prisma';

// 正準 (SSOT) であるドメイン型を読み込む (比較用のもう片側)
import type {
  Role, // 権限 (正準)
  TicketStatus, // チケット状態 (正準)
  Priority, // 優先度 (正準)
  HistoryField, // 履歴項目 (正準)
  FaqStatus, // FAQ 状態 (正準)
  NotificationType, // 通知種別 (正準)
  TenantMode, // テナント動作モード (正準)
  SubscriptionPlan, // 課金プラン (正準 / Phase 4)
  SettingsAuditAction, // 設定変更監査の操作種別 (正準)
  AuthAuditEvent, // 認証イベント監査の種別 (正準)
  QuarantineReason, // 取り込み隔離の理由 (正準)
  QuarantineChannel, // 隔離記録の発生元チャネル (正準)
  MagicLinkPurpose, // マジックリンクトークンの用途 (正準)
} from '@/domain/types';

// 型 A と型 B が「完全に同じ集合」なら true、少しでもズレれば never になる型ユーティリティ。
// A が B の部分集合 かつ B が A の部分集合 のときだけ true を返す (双方向の包含チェック)。
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

// 各 enum について「正準型 と 生成型 が一致する」ことを true の代入で表明する。
// ズレている場合は Exact<...> が never になり、true を代入できず型エラーになる。
const _role: Exact<Role, PRole> = true; // 権限が一致しているかを表明
const _status: Exact<TicketStatus, PStatus> = true; // チケット状態が一致しているかを表明
const _priority: Exact<Priority, PPriority> = true; // 優先度が一致しているかを表明
const _history: Exact<HistoryField, PHistory> = true; // 履歴項目が一致しているかを表明
const _faqStatus: Exact<FaqStatus, PFaqStatus> = true; // FAQ 状態が一致しているかを表明
const _notificationType: Exact<NotificationType, PNotificationType> = true; // 通知種別が一致しているかを表明
const _tenantMode: Exact<TenantMode, PTenantMode> = true; // テナントモードが一致しているかを表明
const _subscriptionPlan: Exact<SubscriptionPlan, PSubscriptionPlan> = true; // 課金プランが一致しているかを表明 (Phase 4)
// 以下 5 つは「schema と domain/types の 2 箇所同期」を各 enum のコメントで口約束していただけで、
// この番人ファイルに登録されておらず機械的なドリフト検知が効いていなかったものを追加した。
// (監査系 enum のズレは、片側だけ増やした値で Prisma の実行時バリデーションが落ちる形で表面化する)
const _settingsAuditAction: Exact<SettingsAuditAction, PSettingsAuditAction> = true; // 設定変更監査の操作種別が一致しているかを表明
const _authAuditEvent: Exact<AuthAuditEvent, PAuthAuditEvent> = true; // 認証イベント監査の種別が一致しているかを表明
const _quarantineReason: Exact<QuarantineReason, PQuarantineReason> = true; // 隔離理由が一致しているかを表明
const _quarantineChannel: Exact<QuarantineChannel, PQuarantineChannel> = true; // 隔離チャネルが一致しているかを表明
const _magicLinkPurpose: Exact<MagicLinkPurpose, PMagicLinkPurpose> = true; // マジックリンク用途が一致しているかを表明

// 上で宣言した定数を void で参照し、「未使用変数」の lint 警告を回避する (値としては使わない)。
void [
  _role,
  _status,
  _priority,
  _history,
  _faqStatus,
  _notificationType,
  _tenantMode,
  _subscriptionPlan,
  _settingsAuditAction,
  _authAuditEvent,
  _quarantineReason,
  _quarantineChannel,
  _magicLinkPurpose,
];
