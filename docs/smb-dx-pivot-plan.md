[← ドキュメント目次](./index.md) / SMB DX ピボットプラン

# DX 未進展の中小企業向けに作り替えるプラン

> 本ドキュメントは **戦略・要件レベルのピボット計画書** です。実装タスクは確定次第 `issue-backlog.md` / `github-issues.md` に切り出します。

---

## 0. エグゼクティブサマリ

- 現行 `HelpDesk Hub` は「情シス担当者が複数人いる中堅〜大企業の社内ヘルプデスク」向けに設計されている（ロール 3 種・SLA・FAQ 候補・SSE 通知などフル機能）。
- ピボット先は **従業員 10〜100 名規模、IT 専任 0〜1 名、現状の問い合わせ管理が「メール／電話／LINE／口頭／Excel」で属人化している中小企業**。
- 勝ち筋は **「最短で Excel から卒業できる、最小単位のヘルプデスク」**。多機能化ではなく **削る・隠す・既存ツールから流し込む** ことで価値を出す。
- 技術スタック（Next.js 15 / Prisma / PostgreSQL / Server Actions）はそのまま流用可能。**スキーマと UI の簡素化、外部チャネル取り込み、料金体系・オンボーディング刷新** が主な作業。

---

## 1. ターゲット顧客像

### 1.1 ペルソナ「町工場の事務員 田中さん（55）」

- 従業員 30 名の金属加工会社で経理・総務・庶務を一人で兼務。
- 「PC が遅い」「複合機の調子が悪い」「勤怠ソフトのパスワード忘れた」を**口頭・内線・LINE グループ・付箋・Excel 一覧表**で受けている。
- 月末になると「あの件どうなった？」が頻発し、対応漏れが起きる。
- SaaS 経験はサイボウズ Office / freee / kintone 体験版くらい。**専門用語（SLA・チケット・エスカレーション）はピンと来ない**。
- スマホは iPhone、社内端末は Windows 10。Chrome は使える。

### 1.2 ペルソナ「現場リーダー 鈴木さん（45）」

- 製造現場の班長。問い合わせの「依頼者」側。
- スマホからしか入力しない。**LINE で田中さんに送れば終わる現状**を捨てるのは抵抗がある。
- 「写真を撮って送るだけで終わってほしい」が最優先。

### 1.3 採用可否を分ける条件

- 価格: **月額 5,000〜20,000 円程度（10 名で）** が現実的な上限。
- 学習: **30 分の説明で田中さんが一人で運用開始できる**こと。
- 既存ツール: **メールと LINE / Chatwork は捨てさせない**。「そこから取り込めるか」が勝負。

---

## 2. 現行プロダクトとのギャップ分析

| 観点 | 現行 (大企業情シス想定) | SMB 想定 | 対応方針 |
| --- | --- | --- | --- |
| ロール | requester / agent / admin の 3 種 | 「依頼する人」「対応する人」の 2 種で十分。管理者は対応者が兼任 | ロールを **「メンバー / 担当者」** の 2 種に簡素化（DB の Role は維持し UI で隠す） |
| ステータス | New / Open / WaitingForUser / InProgress / Escalated / Resolved / Closed（7 種） | 多すぎて使い分けられない。実運用は「未対応 / 対応中 / 完了」 | **3 ステータスの簡易モード**を追加し、Pro モードで現行 7 ステータスを開放 |
| SLA | 初回応答期限・解決期限を別管理、超過バッジ | 「いつまでに」しか気にしない | **「期限日」1 項目**に統合（Pro モードで詳細 SLA 解禁） |
| エスカレーション | 専用ステータス・理由必須・履歴記録 | 一人情シスにエスカレ先がいないことが多い | **既定で非表示**。Pro モードでのみ有効化 |
| FAQ 候補 | 解決済みから FAQ 化、公開/却下管理 | 「またこの質問か」を減らしたいニーズはある | **「よくある質問テンプレ」**として残す（用語を変える） |
| 入力チャネル | Web フォームのみ | 実態は **メール・LINE・電話・口頭** | **メール取り込み**を最優先で追加（後述） |
| 通知 | アプリ内通知 + SSE 未読バッジ | 「アプリ開かない」前提 | **メール通知** & **LINE 通知**を主軸に切替 |
| 認証 | Credentials（email + password） | 「パスワード覚えられない」「招待 URL で入りたい」 | **マジックリンク（メールリンク）認証**を追加 |
| 添付 | 未実装（要件のみ） | **スマホで撮った写真**を送りたい | 写真添付・スマホ最適化を優先実装 |
| ダッシュボード | 件数 / SLA 超過 / 担当者別 | 一人運用だと意味が薄い | **「今週の未対応」「期限切れ」だけの簡易版**に置換 |
| 価格・契約 | 未定義（OSS 風） | SaaS としての販売前提 | 後述「6. マネタイズ」 |

### 2.1 既存スキーマで活かせる資産

- `Ticket` / `TicketComment` / `TicketHistory` / `Notification` / `Category` モデルは構造として十分汎用。**スキーマ破壊変更は最小限**で済む。
- `src/domain/ticket-status.ts` の遷移テーブルが単一の真実。**簡易モード用の縮約遷移表**を別 export すれば既存テストを壊さず追加できる。
- Ports & Adapters の分離（`src/data/`）により、メール取り込みや LINE Webhook 等の **新しい入口を Adapter として足すだけ**で済む構造になっている。

---

## 3. プロダクト戦略 ― 「Lite / Pro」の二層構成

「現行コード資産を残しつつ、SMB に刺さる薄い層を上に被せる」方針。

### 3.1 Lite モード（新規・既定）

- ステータス: **未対応 / 対応中 / 完了** の 3 つだけ。
- ロール表記: **メンバー / 担当者**。
- 期限: **「いつまでに」1 項目**（カレンダー入力）。
- ダッシュボード: **「自分の未対応」「期限切れ・今日まで」**の 2 枚タイル。
- 入口: **Web フォーム / メール転送 / LINE Bot（β）**。
- 通知: **メール必須 / アプリ内バッジは補助**。
- 用語はカタカナ・英語を可能な限り排除。

  | 現行用語 | Lite 用語 |
  | --- | --- |
  | チケット | 問い合わせ |
  | エスカレーション | （非表示） |
  | アサイン | 担当を決める |
  | SLA 超過 | 期限切れ |
  | FAQ 候補 | よくある質問 |
  | ステータス | 状況 |

### 3.2 Pro モード（既存機能の温存）

- 既存の 7 ステータス・SLA・エスカレーション・FAQ 候補・SSE をすべて有効化。
- 設定画面で **テナント単位の `mode: 'lite' | 'pro'`** を切替可能（既定は lite）。
- 既存の E2E テスト・ユニットテストは Pro モード前提のまま温存。Lite モード用の新規テストを追加する形にする。

### 3.3 マルチテナント化

- 現行はシングルテナント。SMB SaaS 化には **テナント分離**が必須。
- `Tenant` モデルを追加し、`User` / `Ticket` / `Category` / `FaqCandidate` / `Notification` に `tenantId` を付与。
- すべての Server Action で `where: { tenantId: session.tenantId }` を強制（`src/lib/auth.ts` の session に `tenantId` を載せる）。
- Adapter 層で **「tenantId スコープ必須」** を契約に組み込み、抜け道をテストで担保。

---

## 4. 機能ロードマップ

> 「現状の Excel 運用から最短で卒業」を北極星指標に置き、フェーズを分ける。

### Phase 0 — 基盤整備（2 週間）

- [x] `Tenant` モデル追加 + 全関連テーブルへの `tenantId` 付与 + マイグレーション
- [x] `auth.ts` の session 拡張（`tenantId` 載せる）と middleware でのスコープ強制
- [x] テナント作成 / 招待リンク発行画面（admin 用）
- [x] 既存 E2E / Vitest をテナント前提に修正

### Phase 1 — Lite モード MVP（4 週間）★ 最重要

- [x] 設定: テナントごとの `mode` 切替フラグ
- [x] UI: 用語差し替え（`src/lib/constants.ts` を mode-aware に）
- [x] ドメイン: `ALLOWED_TRANSITIONS_LITE`（3 ステータス）を `src/domain/ticket-status.ts` に追加。テストも追加
- [x] フォーム: 必須項目を「件名 / 内容 / 期限日」だけに絞る簡易フォーム
- [x] 一覧: 「自分の未対応」「期限切れ」タブ + フリーワード検索のみ
- [x] スマホ最適化（一覧をカード型に、フォームをステップ式に）
- [x] 添付ファイル（画像）対応 ― S3 互換ストレージ / もしくはローカルボリューム + 後で差し替え可能な Adapter
- [x] マジックリンク認証（メール一通でログイン）

### Phase 2 — 既存チャネルからの取り込み（4 週間）★ 差別化の本丸

- [x] **メール取り込み**: 専用転送アドレス（例: `tenant-abc@inbox.helpdesk-hub.app`）に転送するとチケット化。`POST /api/inbound/email` を Webhook として実装（SendGrid Inbound Parse 形式の multipart / JSON 双方を受理）。テナントは `Tenant.inboundToken`（宛先ローカルパート）で特定、共有シークレット検証＋既知メンバー以外は隔離。純粋パーサ `src/lib/inbound-email.ts` ＋ ユニット/ルートテスト付き
- [x] スレッド継続（`In-Reply-To` ヘッダで紐付け）
- [x] **LINE 公式アカウント連携（β）**: 友だち追加 → メッセージ送信でチケット化、担当者の返信が LINE に返る
- [x] メール通知テンプレートの整備（HTML、日本語、件名規約）
- [x] 「対応すると依頼者にメールで返信が届く」を既定動作に（依頼者がアプリにログインしなくても完結）

### Phase 3 — オンボーディング & 業種テンプレ（3 週間）

- [x] テナント作成時に **業種テンプレ**（製造業 / 飲食 / 介護 / 不動産 / 士業 / 卸売 など）でカテゴリと「よくある質問」を初期投入
- [x] **Excel インポート**: 既存の問い合わせ管理 Excel を CSV にして取り込み（最低限の列マッピングウィザード）
- [x] チュートリアル動画リンク・サンプルチケット
- [x] ヘルプセンター（このリポジトリ内に Next.js で同梱、SSG）

### Phase 4 — マネタイズと運用（継続）

- [x] サブスク課金（Stripe Billing）: Free / Standard / Pro の 3 段階
- [x] 監査ログ / バックアップ自動化
- [x] 多店舗・多拠点対応（テナント内サブグループ）
- [x] Slack / Chatwork / Microsoft Teams 通知 Adapter

### スケジュール感

```
Week  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16
P0   ▓▓▓▓
P1         ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
P2                     ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
P3                              ▓▓▓▓▓▓▓▓▓▓▓▓
P4                                          ▓▓▓▓→
```

---

## 5. 技術的な変更点（要点だけ）

> 詳細設計は Phase ごとの GitHub Issue に分解する。ここでは方針のみ。

### 5.1 データモデル変更（Phase 0）

```prisma
model Tenant {
  id        String   @id @default(cuid())
  name      String
  mode      TenantMode @default(lite)   // lite | pro
  industry  String?                      // 業種テンプレ識別子
  createdAt DateTime @default(now())

  users         User[]
  tickets       Ticket[]
  categories    Category[]
  notifications Notification[]
}

enum TenantMode {
  lite
  pro
}

// 既存モデルに tenantId String + relation Tenant を追加
```

### 5.2 ステータス遷移テーブル

`src/domain/ticket-status.ts` に **既存定数を残したまま** 以下を追加：

```ts
// Lite モード用の縮約ステータス（DB は既存 enum を流用し、UI/業務上 3 値だけ使う）
export const LITE_STATUSES = ['Open', 'InProgress', 'Closed'] as const;
export const ALLOWED_TRANSITIONS_LITE: Record<LiteStatus, LiteStatus[]> = {
  Open: ['InProgress', 'Closed'],
  InProgress: ['Open', 'Closed'],
  Closed: ['Open'],
};
```

`src/lib/constants.ts` の日本語ラベルマップを `getStatusLabel(status, mode)` に変更し、Lite 時は「未対応 / 対応中 / 完了」を返す。既存テストは Pro モード前提のまま温存。

### 5.3 入口チャネルの Adapter 化

```
src/data/ports/inbound-channel.ts            # 入口の契約
src/data/adapters/inbound/web-form.ts        # 既存
src/data/adapters/inbound/email-sendgrid.ts  # 新規 (Phase 2)
src/data/adapters/inbound/line-bot.ts        # 新規 (Phase 2)
```

`POST /api/inbound/email`・`POST /api/inbound/line` を Webhook エンドポイントとして用意し、それぞれの Adapter が `Ticket` モデルへの変換と `recordHistory` / `createNotification` を行う。

### 5.4 通知チャネルの Adapter 化

現行は `src/lib/notifications.ts` がアプリ内通知 + SSE のみ。これを Port 化し、

- `notify:app`（既存）
- `notify:email`（新規、最重要）
- `notify:line`（新規）

を **テナント設定で 0〜複数選択**できるようにする。Lite モードの既定は `email` のみ。

### 5.5 認証

- Auth.js v5 に **Email Provider（マジックリンク）** を追加。
- 既存 Credentials Provider は Pro モードのみ表示（既定で隠す）。
- `bcryptjs` 依存はそのまま残す（Pro 用）。

### 5.6 マルチテナント化のセキュリティ担保

- **すべての Server Action / API Route の冒頭で `tenantId` を session から取り出し、Prisma の `where` に必ず差し込む** ことをコーディング規約に明記（CLAUDE.md にも追記）。
- Vitest で「他テナントのデータが取れないこと」のリグレッションテストを必須化（in-memory Adapter で検証）。
- SSE の `sse-subscribers.ts` は in-process Map のため、**水平スケール時に Redis Pub/Sub へ差し替える前提**で Port 化（既存メモがそのまま課題として残る）。

---

## 6. マネタイズ・販売戦略

### 6.1 料金プラン（仮）

| プラン | 月額（税抜） | ユーザー数 | 主な制限 |
| --- | --- | --- | --- |
| Free | 0 円 | 3 名まで | 月 50 件 / メール取り込み不可 / ロゴ表示 |
| Standard | 4,980 円 | 10 名まで | Lite モードフル / メール取り込み / 添付 1GB |
| Pro | 14,800 円 | 30 名まで | Pro モード（SLA・エスカレーション・FAQ）/ LINE 連携 / 監査ログ |
| Enterprise | 個別見積 | 無制限 | SSO（SAML）/ 監査強化 / SLA 契約 |

### 6.2 販売チャネル

- **税理士・社労士・経営コンサル経由の紹介**（中小企業の意思決定に効きやすい）
- **商工会議所セミナー**枠でのワークショップ提供
- **IT 導入補助金**の対象 IT ツール登録（補助率 1/2〜3/4）

### 6.3 KPI

- 北極星: **「導入後 30 日で 50 件以上のチケットが起票されたテナント比率」**（Excel から本当に乗り換えた指標）
- 副次: 月次解約率、メール取り込み利用率、Lite→Pro 転換率

---

## 7. オンボーディング設計

### 7.1 「30 分で運用開始」シナリオ

1. サインアップ（メールアドレスのみ、マジックリンク）
2. テナント名・業種を選択 → カテゴリ・よくある質問が自動投入
3. メンバーを招待（リンク貼り付け or CSV）
4. 「専用のメール転送先（`xxxx@inbox.helpdesk-hub.app`）」を表示。**Gmail / Outlook の自動転送設定の手順動画**を併設
5. テスト送信して 1 件チケット化される瞬間を見せる（「動いた！」体験）
6. スマホでログイン → 期限切れタブをホーム画面に追加

### 7.2 「失敗しない撤退ポイント」

- 30 日間の Free trial（Standard 相当）。延長は問い合わせベース。
- **CSV エクスポート**を全プランで保証（ロックインしない安心感）。

---

## 8. リスクと対策

| リスク | 影響 | 対策 |
| --- | --- | --- |
| 既存ユーザー（情シス向け）と SMB 向けで UI が衝突 | Pro ユーザーの混乱 | `mode` フラグでテナント単位に切替。UI コンポーネントを mode-aware に集約 |
| マルチテナント化のデータ漏えい | 致命的 | Port 層に `tenantId` 強制を契約として埋め込み、回帰テストを必須化 |
| メール取り込みの SPF/DKIM 偽装 | スパム混入・なりすまし | 送信元ドメイン検証 + 既知メンバーのみ起票許可（不明送信者は隔離キューへ） |
| LINE 連携の運用負荷（Bot 認証・友だち追加） | オンボーディング離脱 | Phase 2 では β 提供。Standard プランからの追加機能扱い |
| 価格が高いと感じる SMB | 解約 | Free プランで「Excel より少し便利」を体験してもらい、メール取り込みは Standard 以上の差別化要素にする |
| IT 導入補助金の審査落ち | 販売ペース鈍化 | 補助金対象要件（インボイス対応・セキュリティ自己宣言）を Phase 4 で整備 |

---

## 9. 次のアクション（このリポジトリで着手するもの）

1. 本ドキュメントをレビュー → 承認後、Phase 0 を Issue 化（`docs/issue-backlog.md` に追記）
2. `prisma/schema.prisma` に `Tenant` モデルを追加するマイグレーション PR を切る
3. `src/lib/auth.ts` の session に `tenantId` を載せる改修 PR
4. Lite モードの UI トグル（環境変数 or テナント設定）を `(app)/layout.tsx` 配下に組み込む薄い PR
5. 業種テンプレ JSON（製造 / 飲食 / 介護 / 不動産 / 士業 / 卸売）の初期データ整備

> 各 PR は **1 コミット 1 論理変更** ルール（CLAUDE.md）と **Lite/Pro 両モードのテスト** を満たすこと。
