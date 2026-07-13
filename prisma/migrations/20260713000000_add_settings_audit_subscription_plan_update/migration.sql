-- フォローアップ (2026-07-13): 監査で発見したギャップの解消。
-- Stripe Webhook 起因のプラン変更 (アップグレード/ダウングレード/解約) は §4.4 の
-- tenant_mode_update (Pro モード強制解除の副作用のときのみ記録) では捕捉されず、
-- subscriptionPlan 自体の変更は一度も監査対象になっていなかった。
ALTER TYPE "SettingsAuditAction" ADD VALUE 'subscription_plan_update';
