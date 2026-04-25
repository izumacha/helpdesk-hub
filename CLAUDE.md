# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

HelpDesk Hub — 社内ヘルプデスク向けチケット管理システム。UI text, error messages, and test selectors are in Japanese; preserve that when editing user-facing strings or writing Playwright selectors.

## Commands

```bash
npm run dev          # Next.js dev server (http://localhost:3000)
npm run build        # Production build (outputs standalone for Docker)
npm run typecheck    # tsc --noEmit
npm run lint         # next lint (ESLint 9 flat config + next/core-web-vitals)
npm run format       # Prettier (100 col, single quotes, trailing commas)
npm run test         # Vitest — unit tests in tests/
npm run test:e2e     # Playwright — chromium only, baseURL from BASE_URL or localhost:3000
npm run db:migrate   # prisma migrate dev
npm run db:seed      # tsx prisma/seed.ts
npm run db:generate  # Regenerate Prisma client into src/generated/prisma
```

Single test:

```bash
npx vitest run tests/ticket-status.test.ts
npx vitest run -t 'allows reopening from Resolved to Open'
npx playwright test e2e/auth.spec.ts -g 'ログインページが表示される'
```

Playwright does **not** auto-start the dev server — run `npm run dev` (or `docker compose up`) first, or set `BASE_URL`. E2E tests depend on seeded users (`agent1@example.com` / `requester1@example.com` / `admin@example.com`, all `password123`).

Docker flow: `cp .env.example .env && docker compose up -d && docker compose exec app npx prisma migrate deploy && docker compose exec app npx prisma db seed`.

## Architecture

**Stack:** Next.js 15 App Router, React 19, Auth.js v5 (next-auth@beta, Credentials provider with bcryptjs), Prisma 5 + PostgreSQL, Zod, Tailwind v4, Vitest, Playwright.

### Prisma client location (important)

`prisma/schema.prisma` emits the client to `src/generated/prisma` (not `node_modules/@prisma/client`). **Always import types/enums from `@/generated/prisma`**, e.g. `import type { TicketStatus, Role } from '@/generated/prisma'`. The directory is gitignored — run `npm run db:generate` after cloning, pulling schema changes, or before `npm run typecheck` / `npm run build` in a fresh environment. The Dockerfile runs `prisma generate` before `next build` for the same reason.

Path alias: `@/*` → `src/*` (tsconfig + vitest.config).

### Layer layout

- `src/app/(app)/*` — Route Group for authenticated pages (`dashboard`, `tickets`, `faq`, `notifications`). The `(app)/layout.tsx` reads `auth()` and renders the Sidebar/Header; unauthenticated users never reach it because middleware redirects first.
- `src/app/api/*` — REST endpoints (`POST /api/tickets`, `GET /api/notifications/stream` for SSE, `/api/auth/[...nextauth]`). Most mutations are Server Actions, not API routes; the `/api/tickets` POST exists as an HTTP surface parallel to the form flow.
- `src/features/<domain>/{actions,components}` — Feature modules. `actions/*.ts` are `'use server'` files; `components/*.tsx` are mostly Client Components consumed by pages.
- `src/domain/` — Pure business rules independent of Prisma/Next (currently `ticket-status.ts` transition table).
- `src/lib/` — Cross-cutting infra: `prisma.ts` (singleton), `auth.ts` (NextAuth config), `role.ts` (`isAgent`), `sla.ts`, `notifications.ts`, `sse-subscribers.ts`, `ticket-history.ts`, `constants.ts` (Japanese labels + Tailwind color classes for status/priority/FAQ), `validations/` (Zod schemas).

### Auth & RBAC

Two roles effectively: **requester** (sees only own tickets, can comment on own) vs **agent/admin** (full access). Use `isAgent(role)` from `src/lib/role.ts` — it returns true for both `agent` and `admin`, so never compare `role === 'admin'` directly unless admin-only is intended.

- `src/middleware.ts` runs on every request (matcher excludes `_next/static`, `_next/image`, `favicon.ico`). It returns 401 JSON for unauthenticated `/api/*`, redirects unauthenticated HTML requests to `/login`, and redirects logged-in users off `/login` (agents → `/dashboard`, requesters → `/tickets`).
- `src/lib/auth.ts` extends the JWT and session with `id` and `role`. The module augmentation lives in `src/types/next-auth.d.ts`. `session.user.id` and `session.user.role` are available everywhere.
- Server Actions enforce RBAC themselves — middleware only gates routing. The pattern in `src/features/tickets/actions/update-ticket.ts` is: `const session = await auth(); assertAgentRole(session); ...`. Reuse that assertion pattern; do not rely on the UI hiding controls.
- Page-level RBAC for list/detail queries is done by adding `where.creatorId = session.user.id` when `!isAgent(role)` (see `src/app/(app)/tickets/page.tsx`).

### Mutation pattern (Server Actions)

All ticket/FAQ/notification mutations are `'use server'` functions colocated in `src/features/<domain>/actions/`. The canonical shape:

1. `await auth()` + role assertion.
2. Read current row with `findUniqueOrThrow`.
3. For status changes, gate with `isValidTransition(from, to)` from `src/domain/ticket-status.ts`.
4. Mutate via Prisma.
5. Call `recordHistory(...)` from `src/lib/ticket-history.ts` for status / priority / assignee / escalation changes.
6. Call `createNotification(...)` from `src/lib/notifications.ts` for user-visible events.
7. `revalidatePath('/tickets/<id>')` (and `/faq`, `/notifications` as relevant).

**Never bypass the transition table.** `ALLOWED_TRANSITIONS` in `src/domain/ticket-status.ts` is the single source of truth and is covered by `tests/ticket-status.test.ts`. `escalateTicket` likewise checks `isValidTransition(status, 'Escalated')`. If a state change feels blocked, update the table (and its tests) rather than skipping the check.

### Notifications — unread count pipeline

Unread count is surfaced in real time via Server-Sent Events and a cached Prisma count:

- `src/lib/notifications.ts::getUnreadNotificationCount` wraps the query in `unstable_cache` tagged `notification-count-<userId>` (60 s revalidate).
- `createNotification` writes the row, calls `revalidateTag('notification-count-<userId>')`, then queries a **fresh** count directly and calls `broadcast(userId, count)` from `src/lib/sse-subscribers.ts`. The direct query is intentional — the cache was just invalidated.
- `markAllRead` (in `src/features/notifications/actions/notification-actions.ts`) broadcasts `0` for immediate UI update.
- `GET /api/notifications/stream` (`src/app/api/notifications/stream/route.ts`) opens an EventSource, registers the controller in the in-memory `subscribers` Map, sends initial count, and pings every 30 s to keep the connection alive.

`sse-subscribers.ts` is an **in-process Map**. This works for the standalone Docker deployment but is not safe behind a multi-instance load balancer — surface this before introducing horizontal scaling.

### Validation

Zod schemas live in `src/lib/validations/` (currently `ticket.ts`). Use `safeParse` in API routes and return `422` with `issues` on failure (see `src/app/api/tickets/route.ts`). Forms use `react-hook-form` + `@hookform/resolvers/zod`.

### UI constants

`src/lib/constants.ts` owns every Japanese label and Tailwind color class for status / priority / FAQ status / history field / notification type. Adding a new enum value requires updating the matching maps here, plus the Prisma enum, plus `ALLOWED_TRANSITIONS` if it's a `TicketStatus`.

## Testing

- Vitest `environment: 'node'`, picks up `tests/**/*.test.ts` only. The `@/*` alias is configured in `vitest.config.ts`. Unit tests so far cover pure logic (`ticket-status`, `sla`, `validations`) with no DB/Prisma access — keep that boundary; add DB-touching behavior to E2E instead.
- Playwright is chromium-only, `fullyParallel: true`, retries only in CI. Selectors are regex-based against Japanese copy (`/ログイン/i`, `/メールアドレス|Email/i`) — match that style.

## Conventions to respect

- Prettier: 100 col, single quotes, 2-space indent, trailing commas "all"; `prettier-plugin-tailwindcss` reorders class names.
- Import Prisma enums/types via `@/generated/prisma`, never `@prisma/client`.
- Server Actions throw `Error(...)` with Japanese messages for user-facing failures; callers surface them to the user.
- `docs/` holds design artifacts (`requirements.md`, `architecture.md`, `er-diagram.md`, `screen-flow.md`) — consult before changing status flow, permissions, or the ER model.
- **1行ごとに初心者でも意味がわかるコメントアウトを書く**: コード 1 行ごとに、プログラミング初心者でも処理内容が理解できる日本語コメントを付ける。変数宣言・条件分岐・関数呼び出し・ループ・return など、すべての実行行に対して「何をしているか」を説明するコメントを必ず添える（型定義の単純な再エクスポートなど明らかに自明な行は除く）。コメントは行の直前または行末に記述し、専門用語を使うときは平易な言い換えを併記する。

## Data Layer (Ports & Adapters)

- `src/data/ports/` にリポジトリ契約（インターフェース）を定義。`src/data/adapters/prisma/` が本番実装、`src/data/adapters/memory/` がテスト用。
- 新しいエンティティ操作を追加する場合は Port → Adapter の順に実装し、`src/data/index.ts`（Composition Root）でエクスポートする。
- Prisma を直接 import するのは Adapter 内のみ。Server Actions やコントローラから直接 `prisma.xxx.findMany()` を呼ばない。

## パフォーマンス

- Prisma で関連エンティティを参照する場合は必ず `include` / `select` を明示する。ループ内で個別クエリを発行しない（N+1 問題）。
- リスト画面のクエリには `take` / `skip` でページネーションを適用すること。

## セキュリティ

- ユーザー入力は必ず Zod スキーマ（`src/lib/validations/`）で検証してから DB に渡す。`safeParse` を使い、生の入力を直接 Prisma に渡さない。
- Server Action 内では必ず `await auth()` + ロールチェックを最初に行う。UI の非表示だけに頼らない。
- 環境変数（`NEXTAUTH_SECRET` 等）をコードにハードコードしない。`.env.example` にキー名だけ記載する。

## Git 規約

- コミットメッセージ形式: `type(scope): 日本語の説明`
  - type: feat, fix, refactor, test, docs, chore
  - scope: tickets, faq, notifications, auth, infra 等
- 1 コミット = 1 論理変更。Prisma スキーマ変更とマイグレーションは同一コミットに含める。

## CI (GitHub Actions)

- `.github/workflows/ci.yml` が lint → typecheck → test → E2E を実行する。PR を出す前にローカルで `npm run lint && npm run typecheck && npm run test` を通すこと。
- E2E は CI 上で PostgreSQL サービスコンテナを使う。ローカルでは `docker compose up db` で DB を起動してから `npm run test:e2e`。
