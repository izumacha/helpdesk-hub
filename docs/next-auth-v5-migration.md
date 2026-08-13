[← ドキュメント目次](./index.md)

# next-auth v5 (Auth.js) 安定版への移行計画

- 作成日: 2026-07-26（課題棚卸し「next-auth beta 依存」ギャップ対応）
- 現在の依存: `next-auth@^5.0.0-beta.30`（package.json / package-lock.json で beta.30 に固定）

## 1. リリース状況の調査結果（2026-07-26 時点）

| 項目 | 状況 |
|---|---|
| npm の `next-auth` latest タグ | **v4 系（4.24.x）のまま** |
| v5 安定版（`5.0.0`）のリリース | **未リリース**。v5 は `5.0.0-beta.x` として配布が継続 |
| プロジェクトの動向 | NextAuth は Auth.js へ移行中。新規開発は v5 系に集中しており、v5 beta は本番利用が広く行われている |
| 公式の移行ガイド | <https://authjs.dev/getting-started/migrating-to-v5>（v4 → v5。本リポジトリは適用済み） |
| リリース時期の見通し | 公式のリリース日程は未表明（GitHub Discussion nextauthjs/next-auth#13382 参照） |

参考リンク:

- npm versions: <https://www.npmjs.com/package/next-auth?activeTab=versions>
- Migrating to v5: <https://authjs.dev/getting-started/migrating-to-v5>
- 安定版時期の議論: <https://github.com/nextauthjs/next-auth/discussions/13382>

## 2. 現状評価

- 本リポジトリは **最初から v5 API で実装済み**（`NextAuth()` の handlers/auth エクスポート、
  `src/app/api/auth/[...nextauth]`、JWT strategy、`src/types/next-auth.d.ts` の型拡張）。
  v4 へ戻す選択肢は逆移行になるため取らない。
- beta 依存の主なリスクは「beta 間の破壊的変更」と「セキュリティ修正の追従漏れ」の 2 点。
  いずれも **ロックファイルによる固定 + Dependabot（`.github/dependabot.yml`）による
  更新検知 + CI（lint / typecheck / unit / E2E）での検証** で運用上コントロールする。

## 3. 移行方針

1. **当面は v5 beta を継続利用**する（v4 退行はしない）。
2. **バージョンはロックファイルで固定**し、更新は Dependabot の PR 経由で明示的に取り込む。
   beta 更新 PR ではリリースノートの breaking changes を必ず確認する。
3. **`5.0.0` 安定版が公開されたら Dependabot の PR を契機に §4 のチェックリストで移行**する。
   beta.30 → 安定版の差分は小さいことが見込まれるが、無検証では取り込まない。
4. 安定版の公開が長期化しても、認証ライブラリの乗り換え（別ライブラリへの移行）は影響範囲が
   大きいため現段階では行わない。**半年ごと（次回 2027-01）にリリース状況を再確認**し、
   本書の §1 を更新する。

## 4. 安定版リリース時の移行チェックリスト

- [ ] `next-auth@5.0.0`（安定版）のリリースノート・移行ガイドを読み、beta.30 以降の
      breaking changes を洗い出す
- [ ] `package.json` / `package-lock.json` を更新（`npm install next-auth@5`）
- [ ] 影響範囲の確認（本リポジトリで next-auth に依存しているのは以下）:
  - `src/lib/auth.ts` — `NextAuth()` 初期化・Credentials ×2（パスワード / マジックリンク）・
    jwt/session コールバック・認証イベント監査（`repos.authAudit`）の配線
  - `src/lib/password-authorize.ts` — `User` 型 import
  - `src/proxy.ts` — 認証判定とリダイレクト
  - `src/types/next-auth.d.ts` — セッション/JWT の型拡張（`id` / `role` / `tenantId`）
  - `src/app/api/auth/[...nextauth]/route.ts` — handlers のエクスポート
- [ ] セッション Cookie 名・JWT ペイロード形式の変更有無を確認（変更がある場合、デプロイ時に
      既存セッションが失効することを許容するか、移行措置を入れるかを判断する）
- [ ] `npm run lint && npm run typecheck && npm run test` を通す
- [ ] E2E（`npm run test:e2e`）でログイン・ロール別リダイレクト・マジックリンク・SSO
      ハンドオフの動作を確認する
- [ ] ロールバック手順の確認: 問題発生時は package.json / package-lock.json の revert で
      beta.30 に戻せる（DB スキーマ変更を伴わないため revert のみで完結する）
