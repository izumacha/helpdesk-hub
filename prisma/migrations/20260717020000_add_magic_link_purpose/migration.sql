-- MagicLinkToken.purpose (docs/smb-dx-pivot-plan.md §4.18 フォローアップ):
-- SAML SSO の ACS (/api/auth/sso/<tenantId>/acs) が同じ MagicLinkToken テーブルをセッション
-- 引き渡し (ssoHandoff) に再利用しているため、通常のログイン用マジックリンク (login) と
-- 区別する判別子を追加する。countRecentByEmail (発行レート制限) と invalidateActiveByEmail
-- (再送時の旧トークン失効) を login 用途だけに限定し、進行中の SSO ログインを巻き込まないようにする。

-- CreateEnum
CREATE TYPE "MagicLinkPurpose" AS ENUM ('login', 'ssoHandoff');

-- AlterTable: 既存行はすべて通常のログイン用マジックリンクだったため login をデフォルトにする
ALTER TABLE "MagicLinkToken" ADD COLUMN "purpose" "MagicLinkPurpose" NOT NULL DEFAULT 'login';
