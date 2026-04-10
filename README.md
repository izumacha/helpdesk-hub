# HelpDesk Hub

社内ヘルプデスク向けチケット管理システム。対応漏れ・属人化・SLA遅延を防ぐための問い合わせ管理プラットフォームです。

## 主な機能

| カテゴリ | 機能 |
|---|---|
| 認証 | ログイン/ログアウト、ロール別アクセス制御（requester / agent / admin） |
| チケット | 登録・一覧・詳細・キーワード検索・多条件フィルタ・ページネーション |
| ワークフロー | ステータス遷移管理、優先度・担当者アサイン、コメント、変更履歴 |
| SLA | 解決期限設定・期限間近/超過バッジ表示 |
| エスカレーション | 二次対応へのエスカレーション（理由・日時記録、履歴残存） |
| ダッシュボード | ステータス別件数、SLA超過件数、担当者別ワークロード |
| FAQ候補 | 解決済み問い合わせのFAQ変換（公開/却下管理） |
| 通知 | アサイン・エスカレーション時の自動通知、未読バッジ |

## 技術スタック

| レイヤー | 技術 |
|---|---|
| フロントエンド | Next.js 15 (App Router), React 19, Tailwind CSS v4 |
| 認証 | Auth.js v5 (next-auth@beta), Credentials プロバイダ |
| ORM | Prisma 5 |
| DB | PostgreSQL |
| バリデーション | Zod |
| フォーム | react-hook-form + @hookform/resolvers |
| テスト | Vitest (unit), Playwright (E2E) |
| インフラ | Docker / Docker Compose |

## セットアップ

### Docker を使う場合（推奨）

```bash
cp .env.example .env
docker compose up -d
docker compose exec app npx prisma migrate dev
docker compose exec app npx tsx prisma/seed.ts
```

アプリは http://localhost:3000 で起動します。

### ローカル直接起動

**前提条件:** Node.js 20+, PostgreSQL

```bash
# 依存関係インストール
npm install

# 環境変数設定
cp .env.example .env
# .env の DATABASE_URL と NEXTAUTH_SECRET を編集

# DB マイグレーション & シード
npm run db:migrate
npm run db:seed

# 開発サーバー起動
npm run dev
```

## デフォルトユーザー（seed後）

| メールアドレス | ロール | パスワード |
|---|---|---|
| requester1@example.com | requester | password123 |
| agent1@example.com | agent | password123 |
| admin@example.com | admin | password123 |

## コマンド一覧

```bash
npm run dev          # 開発サーバー起動
npm run build        # プロダクションビルド
npm run typecheck    # 型チェック
npm run lint         # ESLint
npm run format       # Prettier
npm run test         # Vitest ユニットテスト
npm run test:e2e     # Playwright E2E テスト
npm run db:migrate   # Prisma マイグレーション
npm run db:seed      # シードデータ投入
npm run db:generate  # Prisma クライアント再生成
```

## プロジェクト構成

```
src/
├── app/
│   ├── (app)/              # 認証済みレイアウト
│   │   ├── dashboard/      # ダッシュボード
│   │   ├── tickets/        # チケット一覧・詳細・新規
│   │   ├── faq/            # FAQ候補管理
│   │   └── notifications/  # 通知一覧
│   ├── api/                # API Routes
│   └── login/              # ログイン画面
├── components/layout/      # 共通レイアウト
├── domain/                 # ビジネスロジック
├── features/               # 機能別モジュール
├── lib/                    # ユーティリティ・設定
└── types/                  # 型定義
prisma/
├── schema.prisma
└── seed.ts
docs/                       # 設計資料
tests/                      # ユニットテスト
e2e/                        # E2E テスト
```

## 設計資料

- [要件定義](docs/requirements.md)
- [アーキテクチャ](docs/architecture.md)
- [ER 図](docs/er-diagram.md)
- [画面遷移図](docs/screen-flow.md)
