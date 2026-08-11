# HelpDesk Hub ドキュメント

このプロジェクトの設計・運用ドキュメントの目次です。最初に読む場合は [overview](./overview.md) から。

## 入口（最初に読む）

- [overview](./overview.md) — PM・非エンジニア向けのプロジェクト全体解説

## 戦略・プロダクト企画

- [smb-dx-pivot-plan](./smb-dx-pivot-plan.md) — DX 未進展の中小企業向けに作り替えるピボット計画

## 設計

- [requirements](./requirements.md) — 機能要件・スコープ・ステータス遷移の正本
- [architecture](./architecture.md) — システム構成、レイヤ分担、データフロー、SSE 通知
- [er-diagram](./er-diagram.md) — ER 図とテーブル定義
- [screen-flow](./screen-flow.md) — 画面遷移図

## 運用・品質

- [security](./security.md) — セキュリティ・堅牢性メモ
- [version-integration](./version-integration.md) — 差分調停ルール（要件 vs 実装のズレを解決する基準）
- [implementation-notes](./implementation-notes.md) — 実装上の補足メモ
- [backup](./backup.md) — DB バックアップ・リストア手順（CI の backup ワークフローの正本）
- [next-auth-v5-migration](./next-auth-v5-migration.md) — next-auth v5 beta → 安定版への移行計画

## 進捗・レビュー

- [issue-backlog](./issue-backlog.md) — 優先度ベースの実装バックログ

## アーカイブ（歴史的記録・現行状態を反映しない）

- [github-issues](./archive/github-issues.md) — GitHub Issue 登録用の Issue ドラフト集（初期開発時）
- [pr-review-report](./archive/pr-review-report.md) — 過去の PR レビューレポート
- [self-review](./archive/self-review.md) — セルフレビュー記録（2026-04-10）
