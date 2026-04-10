# Requirements

## 1. 概要

- システム名: `helpdesk-hub`
- 目的: ヘルプデスク業務における対応漏れ・属人化・SLA遅延を防ぐ
- 対象: 社内ヘルプデスク、情シス窓口、アプリケーションサポート

## 2. スコープ

### MVP

- 認証（ログイン/ログアウト/ロール別表示）
- 問い合わせ登録、一覧、詳細
- ステータス更新
- 優先度/カテゴリ設定
- 担当者アサイン
- コメント追加
- 変更履歴（ステータス/担当）
- 検索・絞り込み（キーワード、ステータス、カテゴリ、優先度、担当者）

### 実務拡張

- SLA（初回応答期限、解決期限、期限超過/期限間近）
- エスカレーション（理由・日時記録）
- FAQ候補化（解決済み問い合わせから抽出）
- 添付ファイル（スクリーンショット/ログ）
- 通知（アサイン、期限間近、ステータス更新）

### アピール拡張

- ダッシュボード（件数、SLA超過、カテゴリ別、担当者別、日別）
- 品質指標（平均初回応答時間、平均解決時間、再オープン、エスカレーション率）
- 監査ログ（変更者、変更日時、変更前後）
- 権限管理（依頼者/担当者/管理者）
- CSV出力

## 3. 画面一覧

- ログイン
- ダッシュボード
- 問い合わせ一覧
- 問い合わせ詳細
- 問い合わせ登録
- FAQ候補一覧
- 分析レポート
- 管理画面
  - ユーザー管理
  - カテゴリ管理
  - SLA設定

## 4. データモデル（主要）

- users
- tickets
- ticket_comments
- ticket_histories
- categories
- priorities
- statuses
- escalations
- attachments
- faq_candidates
- notifications

### tickets の主要項目

- id
- title
- description
- category_id
- priority
- status
- requester_id
- assignee_id
- first_response_due_at
- resolution_due_at
- escalated_at
- closed_at
- created_at
- updated_at

## 5. ステータス遷移

### ステータス

- New
- Open
- Waiting for User
- In Progress
- Escalated
- Resolved
- Closed

### 許可遷移

- New → Open
- Open → In Progress
- In Progress → Waiting for User
- In Progress → Escalated
- In Progress → Resolved
- Resolved → Closed
- Resolved → Open（再オープン）

## 6. 非機能要件

- TypeScript による型安全性（API、フォーム、状態遷移）
- 業務ルールのサーバ側バリデーション
- 監査可能な変更履歴
- ローカル構築容易性（Docker）
- テスト（単体 + E2E）

> 本要件の差分調停ルールは `docs/version-integration.md` を参照。
