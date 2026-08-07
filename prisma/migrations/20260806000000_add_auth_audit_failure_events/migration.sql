-- 否認防止ギャップの追加解消 (2026-08-06): AuthAuditLog はパスワード経路の失敗しか記録しておらず、
-- マジックリンクの無効トークン試行と SAML の検証失敗 / リプレイ検知 / ユーザー不在は
-- console.warn のサーバーログにしか残っていなかった (再起動やログローテーションで消える)。
-- 認証を「試みて拒否された」事実を追記専用テーブルへ残せるようイベント種別を追加する。
--
-- 注: PostgreSQL 12 以降は ALTER TYPE ... ADD VALUE をトランザクション内で実行できる
-- (追加した値を同一トランザクション内で「使う」ことだけが禁止される)。このマイグレーションは
-- 値を追加するだけで使用しないため、Prisma のトランザクション実行と両立する。
-- IF NOT EXISTS を付けるのは、途中まで適用された状態から再適用しても失敗しないようにするため
-- (NotificationType 系の既存マイグレーションと同じ流儀)。
ALTER TYPE "AuthAuditEvent" ADD VALUE IF NOT EXISTS 'magic_link_login_failure';
ALTER TYPE "AuthAuditEvent" ADD VALUE IF NOT EXISTS 'sso_assertion_rejected';
ALTER TYPE "AuthAuditEvent" ADD VALUE IF NOT EXISTS 'sso_assertion_replayed';
ALTER TYPE "AuthAuditEvent" ADD VALUE IF NOT EXISTS 'sso_user_not_found';
