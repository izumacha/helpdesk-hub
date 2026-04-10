# 4バージョン統合レビュー

この文書は、既存資料を4つの観点（=バージョン）として検証し、矛盾のない単一仕様に統合するための基準を定義します。

## 対象バージョン

- **Version 1: プロダクト定義**（README）
  - 目的、対象ユーザー、利用シーン、3フェーズ戦略
- **Version 2: 要件定義**（requirements）
  - スコープ、画面、エンティティ、状態遷移、非機能要件
- **Version 3: 実装タスク**（issue-backlog）
  - 優先度付きIssue、完了条件、依存関係
- **Version 4: 統合基準**（本ドキュメント）
  - 命名規約、正本（source of truth）、差分解消ルール

## 一貫性チェック結果

### 1) 機能スコープの整合

- README の3フェーズ構造（MVP/実務拡張/アピール拡張）と requirements のスコープは一致。
- issue-backlog の P0/P1/P2 は上記フェーズに1対1で対応。

**統合方針**
- フェーズ名称は以下を正本とする。
  - P0 = MVP
  - P1 = 実務拡張
  - P2 = アピール拡張

### 2) ステータス遷移ルールの整合

- requirements に定義した遷移（New→Open→In Progress→...）と issue-backlog #8/#9 は一致。
- 再オープンの扱い（Resolved→Open）も一致。

**統合方針**
- 状態遷移の正本は requirements。
- 実装時は `enum/union` + サーバ側検証を必須。

### 3) データモデルの整合

- requirements の主要テーブルと backlog の実装順は矛盾なし。
- ただし migration 実装時に「優先度」「ステータス」の表現を `enum` か `master table` かで統一が必要。

**統合方針**
- 初期実装は `enum` 優先。
- 将来的に管理画面で可変化したくなった時点で master table 化を検討。

### 4) 受け入れ基準（Definition of Done）の整合

- backlog 全Issueに完了条件があるため、レビュー可能性は担保。
- 非機能（型安全、監査、テスト、Docker）は requirements に明記済み。

**統合方針**
- すべてのIssueで「実装 + テスト + ドキュメント更新」を完了条件に含める。

## 4バージョン統合後の正本ルール

1. **機能要件の正本**: `docs/requirements.md`
2. **実装順序の正本**: `docs/issue-backlog.md`
3. **外部説明の正本**: `README.md`
4. **差分調停の正本**: `docs/version-integration.md`

## 差分が出たときの優先順位

1. セキュリティ/権限境界（最優先）
2. 状態遷移の業務ルール
3. データ整合性（監査ログ含む）
4. UI/UX
5. 文言・命名

## 今後の運用

- 仕様変更PRでは、以下3点を同時更新する。
  1. `docs/requirements.md`
  2. `docs/issue-backlog.md`
  3. `README.md`（外部説明に影響する場合）
- 変更が大きい場合は本書に「整合チェック結果」を追記する。
