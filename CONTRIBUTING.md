# コントリビューションガイド (Contributing)

HelpDesk Hub への変更は、以下のルールに従ってください。開発コマンド・アーキテクチャ・
コーディング規約の詳細は [CLAUDE.md](CLAUDE.md)（§2 コマンド / §3 アーキテクチャ / §4〜§15 共通規約）が
正であり、本書はその入口とセキュリティ関連の実務手順をまとめたものです。

## はじめに

- プロダクト方針の正本は `docs/smb-dx-pivot-plan.md`。方針に反する変更は、先に計画書を
  PR で更新してから着手してください。
- 脆弱性を発見した場合は **公開 Issue にせず** [SECURITY.md](SECURITY.md) の窓口へ報告してください。

## 開発フロー

```bash
npm ci                # 依存インストール
npm run db:generate   # Prisma クライアント生成 (クローン後・スキーマ変更後は必須)
npm run dev           # 開発サーバー
```

PR を出す前に、最低限つぎを通してください（CI と同じ検証です）。

```bash
npm run lint
npm run typecheck
npm run test
```

DB スキーマを変更する場合はマイグレーションを同一コミットに含め、契約テスト
（`npm run test:contract`、専用 DB が必要）の追随も確認してください。

## ブランチ / コミット規約

- 開発は機能ブランチで行い、`main` への直 push は避ける。
- コミットメッセージは `type(scope): 日本語の説明`（例: `feat(tickets): 期限フィルタの追加`）。
- 1 コミット = 1 論理変更。

## コミット署名（否認防止 / 必須化推奨）

監査ログの追記専用化（DB 側）と対で、**リポジトリ履歴側の否認防止**としてコミット署名を使います。
「誰がこの変更を作ったか」を後から否認・偽装できないようにするためのものです。

### SSH 鍵で署名する場合（推奨・最も簡単）

```bash
# 1. 署名フォーマットを SSH にする
git config --global gpg.format ssh

# 2. 署名に使う公開鍵を指定する (既存の SSH 鍵を流用可)
git config --global user.signingkey ~/.ssh/id_ed25519.pub

# 3. すべてのコミット/タグを自動署名する
git config --global commit.gpgsign true
git config --global tag.gpgsign true
```

GitHub 側で **Settings → SSH and GPG keys → New SSH key** を開き、鍵種別
**「Signing Key」** として同じ公開鍵を登録すると、コミットに **Verified** バッジが付きます
（認証用に登録済みの鍵でも、署名用として別途登録が必要です）。

### GPG 鍵で署名する場合

```bash
gpg --full-generate-key                          # 鍵の生成 (Ed25519 推奨)
gpg --list-secret-keys --keyid-format=long       # 鍵 ID を確認
git config --global user.signingkey <鍵ID>
git config --global commit.gpgsign true
```

公開鍵（`gpg --armor --export <鍵ID>`）を GitHub の **GPG keys** に登録してください。

### ブランチ保護での強制（リポジトリ管理者向け）

署名を運用ルールで終わらせず、**Settings → Branches →（`main` の保護ルール）→
「Require signed commits」** を有効化して未署名コミットの push を拒否してください。
これはリポジトリ管理者のみが設定できます（コードからは設定できないため、本書に手順として残す）。

## Pull Request

- PR は draft ではなく ready で作成する。
- PR 本文に、対象作業が `docs/smb-dx-pivot-plan.md` のどの Phase / 項目に対応するかを明記する。
- UI 変更時は `docs/screenshots/` の該当スクリーンショットを同一 PR で更新する。
