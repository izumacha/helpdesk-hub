# セキュリティポリシー (Security Policy)

HelpDesk Hub は中小企業向けの SaaS を目指すチケット管理システムです。本書は脆弱性の報告窓口と、
報告後の対応プロセス・運用上のセキュリティ前提を定めます。

## 脆弱性の報告窓口 (Reporting a Vulnerability)

**公開 Issue / Pull Request / Discussion に脆弱性の詳細を書かないでください。**
修正が公開される前に攻撃者へ情報を渡してしまいます。

報告は GitHub の **Private Vulnerability Reporting**（非公開の脆弱性報告）で受け付けます。

1. リポジトリの **[Security] タブ → [Report a vulnerability]** を開く
   （直接リンク: <https://github.com/izumacha/helpdesk-hub/security/advisories/new>）
2. 再現手順・影響範囲・想定される深刻度を記載して送信する
3. 以後のやり取りは非公開の Security Advisory 上で行う

Private Vulnerability Reporting が利用できない場合は、詳細を伏せた連絡用 Issue
（「セキュリティに関する連絡があります」程度の記載）を作成してください。非公開の連絡手段を
こちらから案内します。

### 報告に含めてほしい情報

- 影響を受ける機能・エンドポイント（例: `POST /api/tickets`、SSO ACS 等）
- 再現手順（可能なら curl / スクリーンショット）
- 想定される影響（情報漏洩・権限昇格・クロステナント越境 等）
- 発見時の環境（コミット SHA / ブランチ）

### 対応目標 (SLA)

| フェーズ | 目標 |
|---|---|
| 受領確認 | 3 営業日以内 |
| 初期評価（深刻度判定） | 7 日以内 |
| 修正リリース | 深刻度 Critical/High: 30 日以内 / Medium 以下: 90 日以内を目安 |
| 公表（協調的開示） | 修正リリース後。報告者の希望があればクレジットを記載 |

## 対象バージョン (Supported Versions)

| バージョン | サポート |
|---|---|
| `main` ブランチ（最新） | ✅ 修正対象 |
| それ以前のコミット | ❌ 最新への更新を推奨 |

## スコープ

**対象**: 本リポジトリのアプリケーションコード（認証・認可・マルチテナント分離・
Webhook 署名検証・添付ファイル処理・メール/LINE 取り込み・SSO/SAML 等）。

**対象外**:

- セルフホスト環境の設定不備（`NEXTAUTH_SECRET` 未設定など。アプリは fail-fast で検知します）
- 依存ライブラリ自体の脆弱性（Dependabot（`.github/dependabot.yml`）で追跡し、
  影響がある場合は本体側で更新対応します）
- レート制限を超える大量リクエストの負荷試験（無断のストレステストはご遠慮ください）

## 運用上のセキュリティ前提（否認防止・監査）

- **監査ログは追記専用（append-only）**: `SettingsAuditLog` / `TicketHistory` / `AuthAuditLog` は
  DB トリガで UPDATE（改竄）を例外なく拒否し、DELETE も原則拒否します
  （`prisma/migrations/20260726000100_add_audit_log_immutability`）。テナントの完全削除など
  意図的な運用操作に限り、(a) トランザクション内での
  `SET LOCAL helpdesk.allow_audit_delete = 'on'` の明示と、(b) スーパーユーザーまたは
  `helpdesk_audit_admin` ロールのメンバーであること、の**両方**を満たす場合のみ DELETE を
  許可します（break-glass。アプリコードはこのフラグを設定せず、アプリ用 DB ロールは
  (b) を満たさないように運用してください）。
- **認証イベントの記録**: ログイン成功/失敗は `AuthAuditLog` に記録されます。パスワード・
  マジックリンク・SSO(SAML) のすべての経路が対象で、SAML はアサーションの受理に加えて
  検証失敗・リプレイ検知・テナント内ユーザー不在も記録します。失敗イベントの書き込みには
  ストレージ枯渇を防ぐための上限があり、上限を超えた分はサーバーログにのみ残ります。
- **DB ロールの最小権限**: 運用 DB ではアプリ用 DB ユーザーにテーブル所有者権限
  （TRUNCATE / DROP / トリガ変更が可能な権限）を与えず、マイグレーション実行用ロールと
  分離してください（行トリガは TRUNCATE では発火しないため、所有者権限の管理が
  追記専用性の最後の砦になります）。
- **コミット署名**: コミットの改竄・なりすまし防止のため、コミット署名（SSH/GPG）と
  ブランチ保護での「Require signed commits」有効化を推奨します。設定手順は
  [CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。
