-- 否認防止 (non-repudiation): 監査ログ 3 テーブル (SettingsAuditLog / TicketHistory /
-- AuthAuditLog) を DB 層で追記専用 (append-only) にする。
--
-- アプリ層はこれらのテーブルに元々追記 (INSERT) しかしないが、DB 接続を得た者 (アプリの
-- バグ・SQL インジェクション・流出した接続文字列) による事後改竄・証跡消去をデータベース側で
-- 拒否するための多層防御 (CLAUDE.md §9 fail-closed と同方針)。
--
-- ルール:
--  * UPDATE (改竄) は例外なく拒否する。
--  * DELETE は原則拒否。ただし「テナントの完全削除 (オフボーディング)」や「E2E テストの
--    後始末」のような意図的な運用操作のために break-glass 経路を 1 つだけ用意する。許可条件は
--    次の (a)(b) の **両方**:
--      (a) トランザクション内で `SET LOCAL helpdesk.allow_audit_delete = 'on'` を明示している
--          (SET LOCAL はトランザクション終了で自動的に失効する)
--      (b) セッションユーザーがスーパーユーザー、または `helpdesk_audit_admin` ロールのメンバー
--    GUC は任意のセッションが自由に設定できてしまうため、(b) の権限条件が無いと SQL
--    インジェクション/流出した接続文字列の攻撃者が自力でフラグを立てて証跡を消せる。
--    アプリ用 DB ロールを非スーパーユーザー・非メンバーで運用すること (SECURITY.md 参照)。
--    アプリコードはこの GUC を設定しない。E2E の後始末は e2e/cleanup.ts の
--    deleteTenantsForCleanup() がこの経路を使う (CI / ローカルの DB ユーザー postgres は
--    スーパーユーザーなので (b) を満たす)。
--
-- 注意:
--  * 行レベルトリガは TRUNCATE では発火しない (PostgreSQL の仕様)。契約テスト
--    (RUN_PRISMA_CONTRACT=1) の beforeEach TRUNCATE によるリセットはこの制約の影響を
--    受けない。運用 DB での TRUNCATE / DROP / トリガ削除はテーブル所有者権限が前提であり、
--    その権限管理 (アプリ用 DB ユーザーと所有者ロールの分離) は SECURITY.md の運用ガイドに従う。
--  * アプリに Ticket / Tenant の物理削除機能は存在しないため、FK の ON DELETE CASCADE 経由で
--    このトリガに到達する経路は現状無い。将来テナント削除機能を追加する場合は、この break-glass
--    経路を使うか「監査ログを残したまま論理削除する」設計にすること。
--  * CI の contract / e2e ジョブは `prisma db push` でスキーマ同期するため本トリガは作成されない
--    (db push はマイグレーション SQL を実行しない)。トリガの実機検証は migrate deploy 済みの
--    環境で行う。

-- 監査ログ行の変更・削除を拒否する共通トリガ関数
CREATE OR REPLACE FUNCTION forbid_audit_row_mutation() RETURNS trigger AS $$
BEGIN
    -- UPDATE (事後改竄) は break-glass を用意せず、例外なく拒否する
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'audit log table "%" is append-only: UPDATE is not allowed', TG_TABLE_NAME;
    END IF;
    -- DELETE は「break-glass フラグ + 権限 (スーパーユーザー or helpdesk_audit_admin)」の
    -- 両方を満たす場合のみ許可する (ファイル冒頭コメントのルール参照)
    IF current_setting('helpdesk.allow_audit_delete', true) IS NOT DISTINCT FROM 'on'
       AND (
           -- (b-1) セッションユーザーがスーパーユーザーか
           (SELECT rolsuper FROM pg_roles WHERE rolname = session_user)
           -- (b-2) または helpdesk_audit_admin ロール (存在する場合) のメンバーか
           OR EXISTS (
               SELECT 1 FROM pg_roles r
               WHERE r.rolname = 'helpdesk_audit_admin'
                 AND pg_has_role(session_user, r.oid, 'MEMBER')
           )
       )
    THEN
        -- BEFORE DELETE トリガは OLD を返すと削除処理が続行される
        RETURN OLD;
    END IF;
    -- 条件を満たさない DELETE は拒否する (メッセージに解除条件を含め、意図的な運用操作を妨げない)
    RAISE EXCEPTION 'audit log table "%" is append-only: DELETE requires both SET LOCAL helpdesk.allow_audit_delete = ''on'' (inside a transaction) and superuser or helpdesk_audit_admin membership', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

-- SettingsAuditLog (設定変更監査ログ) を追記専用化
CREATE TRIGGER settings_audit_log_immutable
    BEFORE UPDATE OR DELETE ON "SettingsAuditLog"
    FOR EACH ROW EXECUTE FUNCTION forbid_audit_row_mutation();

-- TicketHistory (チケット変更履歴) を追記専用化
CREATE TRIGGER ticket_history_immutable
    BEFORE UPDATE OR DELETE ON "TicketHistory"
    FOR EACH ROW EXECUTE FUNCTION forbid_audit_row_mutation();

-- AuthAuditLog (認証イベント監査ログ) を追記専用化
CREATE TRIGGER auth_audit_log_immutable
    BEFORE UPDATE OR DELETE ON "AuthAuditLog"
    FOR EACH ROW EXECUTE FUNCTION forbid_audit_row_mutation();
