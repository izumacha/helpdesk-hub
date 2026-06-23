-- Migration: NotificationType enum に 'imported' 値を追加する
-- Phase 1 / Phase 2 の CSV・メール一括取り込み機能で発行する通知種別として使用する。
--
-- PostgreSQL では ALTER TYPE ... ADD VALUE は DDL トランザクション外でのみ実行できる。
-- Prisma はデフォルトでトランザクションを使うため、このファイルには pragma: notx を設定する必要はなく、
-- Prisma が自動的にトランザクション外で実行する。
-- IF NOT EXISTS を付けることでべき等性を保ち、再実行しても安全にする。
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'imported';
