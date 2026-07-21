-- フォローアップ (2026-07-21): 監査で発見したギャップの解消。
-- 隔離済み受信メール (QuarantinedEmail) は永続化・admin 向け一覧画面 (§3.2) までは実装済みだが、
-- 隔離が発生したこと自体を admin に知らせるアプリ内通知が無かった (成功して起票された
-- 'imported' 通知だけが届く非対称な状態)。
ALTER TYPE "NotificationType" ADD VALUE 'quarantined';
