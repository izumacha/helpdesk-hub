# アーキテクチャ

## 概要

Next.js 15 App Router をベースとしたフルスタック構成。Server Components でデータフェッチ、Server Actions でミューテーションを処理します。

## システム構成

```
┌─────────────────────────────────────────────────┐
│                   Browser                        │
│  React 19 (Client Components + useTransition)   │
└────────────────────┬────────────────────────────┘
                     │ HTTP / Server Actions
┌────────────────────▼────────────────────────────┐
│              Next.js 15 (App Router)             │
│                                                  │
│  ┌──────────────┐  ┌────────────────────────┐   │
│  │ Server       │  │ Server Actions          │   │
│  │ Components   │  │ (mutations + revalidate)│   │
│  └──────┬───────┘  └──────────┬─────────────┘   │
│         │                     │                  │
│  ┌──────▼─────────────────────▼─────────────┐   │
│  │         Prisma Client (ORM)               │   │
│  └──────────────────┬────────────────────────┘   │
└─────────────────────┼──────────────────────────┘
                      │
┌─────────────────────▼──────────────────────────┐
│               PostgreSQL                         │
└────────────────────────────────────────────────┘
```

## ディレクトリ構成の考え方

| ディレクトリ | 役割 |
|---|---|
| `src/app/(app)/` | 認証済みページ群（Route Group） |
| `src/domain/` | ビジネスロジック（ステータス遷移ルールなど）|
| `src/features/` | 機能別モジュール（actions / components） |
| `src/lib/` | 横断的ユーティリティ（prisma, auth, sla, notifications） |
| `src/components/layout/` | 共通 UI（Sidebar, Header） |

## 認証フロー

```
ブラウザ → /login → Credentials認証 → JWT セッション
未認証で保護ページアクセス → middleware → /login リダイレクト
JWT にユーザー ID・ロールを格納 → session.user.id / session.user.role
```

## データミューテーション

Server Actions (`'use server'`) を使用。クライアントから直接呼び出し、完了後に `revalidatePath` でキャッシュを破棄してページを再レンダリング。

## RBAC

| ロール | チケット閲覧 | チケット更新 | エスカレーション | FAQ管理 |
|---|---|---|---|---|
| requester | 自分のみ | 不可 | 不可 | 不可 |
| agent | 全件 | 可 | 可 | 可 |
| admin | 全件 | 可 | 可 | 可 |
