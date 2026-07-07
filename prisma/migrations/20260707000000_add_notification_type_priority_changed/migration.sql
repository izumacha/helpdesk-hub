-- Migration: NotificationType enum に 'priorityChanged' 値を追加する
-- updateTicketPriority (優先度変更) が発行する通知種別として使用する。
--
-- PostgreSQL では ALTER TYPE ... ADD VALUE は DDL トランザクション外でのみ実行できる。
-- Prisma はデフォルトでトランザクションを使うため、このファイルには pragma: notx を設定する必要はなく、
-- Prisma が自動的にトランザクション外で実行する。
-- IF NOT EXISTS を付けることでべき等性を保ち、再実行しても安全にする。
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'priorityChanged';
