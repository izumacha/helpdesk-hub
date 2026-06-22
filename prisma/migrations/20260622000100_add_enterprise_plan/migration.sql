-- Phase 4 課金: 料金プランに Enterprise 階層を追加する (smb-dx-pivot-plan.md §6.1)。
-- Enterprise は個別見積で、無制限 + SSO(SAML) + 監査強化を提供する。
-- Stripe の自助チェックアウトは経由せず、運用側が手動で設定する想定。
--
-- PostgreSQL の enum へ値を追加する。ADD VALUE は既存値の後ろに追記され、
-- 既存行・既定値 (free) には影響しない。PG 12+ ではトランザクション内で実行可能
-- (同一トランザクション内で新値を「使用」しなければよく、本マイグレーションは追加のみ)。
ALTER TYPE "SubscriptionPlan" ADD VALUE 'enterprise';
