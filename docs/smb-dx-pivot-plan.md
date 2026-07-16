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

#### 1.1 フォローアップ（2026-07-09）: FAQ 候補が Lite テナントでは事実上使えなかった

監査で発見したギャップ: §2 のギャップ分析表は「FAQ 候補 →**よくある質問テンプレ**として残す
（用語を変える）」と明記しており、エスカレーション（Lite では非表示）とは異なり Lite でも
機能自体は使える設計意図だった。実装は `FAQ_ELIGIBLE_STATUSES = ['Resolved']`（Pro 専用ステータス）
固定で FAQ 候補化可否を判定していたが、Lite の遷移表（`ALLOWED_TRANSITIONS_LITE`）には
`Resolved` が存在しない（Lite の「完了」は `Closed`）。そのため Lite テナントで起票・完了した
チケットは Resolved に到達できず、`canAddFaq` が常に false、`createFaqCandidate` も常に拒否され、
「よくある質問」の登録導線自体（サイドバーの `/faq` リンク）も `proOnly` で非表示にされていた。
Phase 1〜3 のロードマップ上は `[x]` 済みの機能が、既定モード（Lite）を使う大多数の SMB テナントに
対しては一度も動作しない、という §4.1〜§4.3 と同種の「完了扱いだが実際には機能していない」ギャップ
だった。

- `src/domain/ticket-status.ts` に `getCompletionStatuses(mode)`（Pro: `['Resolved']` / Lite:
  `['Closed', 'Resolved']`）を追加し、`update-ticket.ts` の `completionStatuses`（resolvedAt 判定）
  と FAQ 候補化可否判定の両方がこの 1 関数を共有するようにした（`/code-review ultra` 指摘対応:
  当初は `src/lib/constants.ts` に `update-ticket.ts` と同じ三項演算子を書き写しただけの重複実装
  だったため、ドメイン層の単一の源に統合し直した）。`FAQ_TERM_LABELS`（Lite: 「よくある質問」/
  Pro: 「FAQ候補」）は表示専用の一元管理の定数として `src/lib/constants.ts` に追加（§6）。
- `createFaqCandidate`（`src/features/faq/actions/faq-actions.ts`）・チケット詳細ページの
  `canAddFaq`・サイドバーの `/faq` ナビ項目・`/faq` 一覧ページの見出し/空状態文言を、いずれも
  この mode-aware な判定/呼称に切り替えた。サイドバーは `proOnly` による非表示をやめ、呼称だけ
  mode に応じて切り替える方式にした。`/code-review ultra` 指摘対応: `createFaqCandidate` /
  `updateFaqStatus` が投げるエラーメッセージ（入力値不正・完了状態でない・見つからない）も
  `FAQ_TERM_LABELS` 経由にし、Lite テナントの画面上で「よくある質問」と「FAQ候補」の呼称が
  混在しないようにした。
- `tests/features/faq-actions.test.ts` を新規追加し、Pro/Lite 双方の完了判定・後方互換
  （Lite テナントに残る旧 Resolved データも候補化可能）を検証。`e2e/lite-mode.spec.ts` の
  「FAQ候補が非表示であること」テストを「よくある質問として表示されること」に更新した。

#### 1.2 フォローアップ（2026-07-14 #5）: 公開済み FAQ が依頼者から一度も見られない状態だった

監査で発見したギャップ: §1.1 フォローアップで「Lite テナントでも FAQ 候補（よくある質問）の
機能自体は使える」ことは修正したが、`/faq` ページ自体が `isAgent(session.user.role)` でない
場合に `notFound()` を返す実装のままだった（`src/app/(app)/faq/page.tsx`）。サイドバーの
`/faq` ナビ項目も `agentOnly: true`（`src/components/layout/Sidebar.tsx`）で依頼者には
表示されなかった。§2 のギャップ分析表は FAQ 候補について「『またこの質問か』を減らしたい
ニーズはある」と明記しており、これは依頼者自身が過去の Q&A を検索・閲覧できて初めて成立する
価値提案だが、実装は「エージェントが公開操作をするための画面」としてしか存在せず、公開
（Published）した FAQ を依頼者が読む経路が一つも無かった。Phase 3 の業種テンプレは
テナント作成時に FAQ を自動投入して即座に `Published` にする（`src/lib/tenant-provisioning.ts`）
ため、この経路の欠落は「作成した瞬間から誰にも読まれないコンテンツ」を量産していたことになる。
依頼者は同じ質問を毎回チケットとして起票するしかなく、§0 北極星指標が目指す「Excel より少しでも
楽になる」体験にも反していた。

- `FaqRepository` に `listPublished(tenantId)` を追加（Prisma + メモリ両 Adapter で実装）。
  既存の `list(tenantId)`（エージェント向け管理用、全ステータス・元チケット・作成者名を含む）
  とは別に、公開済み（`Published`）のみを `{ id, question, answer }` の最小フィールドで返す
  （§9 最小権限・最小公開: 元チケットや作成者名は依頼者向けには不要な内部情報のため含めない。
  隔離記録が本文を保存しないのと同じ範囲最小化の考え方）。
- `src/app/(app)/faq/page.tsx` の `notFound()` による依頼者締め出しを廃止し、ロールで表示を
  分岐する構成にした。エージェントは従来どおりの候補管理ビュー（`list` ＋ 公開/却下操作）、
  依頼者は `listPublished` を使った閲覧専用ビュー（質問・回答のみ、ステータスバッジや元チケット
  リンク、公開/却下ボタンは含めない）を見る。どちらのロールも 404 にはならない。
  `updateFaqStatus`（`src/features/faq/actions/faq-actions.ts`）はサーバー側で既に
  `isAgent` を強制していたため変更不要だった（UI 非表示に頼らない §9 の設計が既に効いていた）。
- `src/components/layout/Sidebar.tsx` の `/faq` ナビ項目から `agentOnly: true` を外し、
  全ロールに表示されるようにした。
- `tests/data/faq-repository.memory.test.ts` / `faq-repository.contract.prisma.test.ts` に
  `listPublished` が公開済みのみをテナントスコープで返すこと（候補中のものと他テナントの
  公開済みを含めないこと）の回帰テストを追加した。`e2e/faq.spec.ts` を新設し、依頼者が
  404 にならず公開済み FAQ のみ閲覧できること・候補のままの FAQ や公開/却下ボタンが見えない
  こと・サイドバーにリンクが表示されること、およびエージェント向け管理ビューの回帰
  （候補も含めて見え、公開/却下ボタンが使えること）を検証する。

#### 1.3 フォローアップ（2026-07-14 #6）: 公開済み FAQ を訂正・取り下げる手段が一つも無かった

監査で発見したギャップ: §1.2 フォローアップで公開済み FAQ を依頼者が閲覧できるようにしたが、
一度 `Published` になった FAQ 候補の質問/回答を編集する手段、および誤って公開した内容を
取り下げる（非公開に戻す）手段がアプリのどこにも存在しなかった。`updateFaqStatus`
（`src/features/faq/actions/faq-actions.ts`）は `status !== 'Candidate'` を一律で拒否し、
UI（`src/app/(app)/faq/page.tsx`）も `Candidate` 行にしか操作ボタンを出していなかった。
`FaqRepository` の port にも `update`/`delete` 相当のメソッドが無く、`FaqCandidate.ticketId`
がユニーク制約（1 チケット 1 候補）のため、同じチケットから新しい候補を作り直す回避策も
使えなかった。Phase 3 の業種テンプレ自動投入（`src/lib/tenant-provisioning.ts`）は生成した
FAQ を `Candidate` を経由せず直接 `Published` にするため、テンプレの答えが実情と合わない
場合や、エージェントの操作ミスで誤って公開した場合、その誤った内容が §1.2 で全依頼者に
公開されたまま恒久的に訂正不能という状態だった。§2 のギャップ分析表が謳う「『またこの質問か』
を減らしたい」という価値提案は、公開される内容が正しく保たれて初めて成立する。

- `FaqRepository`（`src/data/ports/faq-repository.ts`）に `updateContent(id, {question,
  answer}, tenantId)` を追加（Prisma + メモリ両 Adapter で実装。`updateStatus` と同じ
  tenantId スコープの `updateMany`/no-op パターン）。
- `updateFaqContent` サーバーアクション（`src/features/faq/actions/faq-actions.ts`）を追加。
  `createFaqCandidate` と同じ `faqCandidateSchema` で入力検証し、ステータスを問わず
  （`Candidate`/`Published`/`Rejected` いずれでも）質問/回答を書き換えられる。
- `updateFaqStatus` の遷移ガードを拡張し、`Published → Rejected`（非公開化）を許可した。
  `Candidate → Published/Rejected` は既存どおり。`Rejected` からの遷移は対象外のまま変更幅を
  絞った（候補への差し戻しは別スコープ）。判定ロジックは `src/domain/ticket-status.ts` の
  `ALLOWED_TRANSITIONS` と同じパターンで `src/domain/faq-status.ts` に切り出し、Server Action
  からインラインの真偽式ではなく単一の遷移表 (`isValidFaqTransition`) を参照させた
  （/code-review ultra 指摘対応: UI 側の条件分岐と別々に真偽式を持つと片方だけ更新して
  食い違う恐れがあったため）。
- エージェント向け管理ビュー（`/faq`）に `FaqEditForm`（`src/features/faq/components/
  FaqEditForm.tsx`）を配置し、全ステータスの FAQ をその場編集できるようにした。`Published`
  行には「非公開にする」ボタンも追加した。依頼者向け閲覧ビューには影響しない
  （`listPublished` 経由のため編集・状態変更 UI は最初から出ない）。既存の
  `FaqCandidateForm.tsx`（チケット詳細からの新規登録フォーム）と質問/回答入力 UI が
  同型だったため、共通実装 `FaqInlineForm.tsx` へ切り出して両者から再利用する形にした
  （§6 DRY: 2 箇所目の重複を共通化。/code-review ultra 指摘対応）。一覧内に並ぶ「編集」
  「公開する」「却下」「非公開にする」ボタンには対象の質問文を含む `aria-label` を付け、
  スクリーンリーダーで対象を区別できるようにした（§7 a11y）。
- `tests/features/faq-actions.test.ts` に `updateFaqStatus`/`updateFaqContent` の状態遷移・
  RBAC 回帰テストを追加。`tests/data/faq-repository.{memory,contract.prisma}.test.ts` に
  `updateContent` のテナントスコープ回帰テストを追加。`e2e/faq.spec.ts` に、共有 seed とは
  独立した専用 fixture を使うエージェント向け編集・非公開化のシナリオを追加した。

#### 1.4 フォローアップ（2026-07-15）: FAQ 状態変更の競合安全化と操作ボタンのエラー処理

§1.3 の `/code-review ultra` フォローアップレビューで発見したギャップの修正。

- **check-then-act 競合（TOCTOU）の解消**: `updateFaqStatus` は行を読み → 遷移表で検証 →
  無条件の `updateMany` で書く構成だったため、読み取りと書き込みの間に別の操作が状態を
  変えると、遷移表が禁止する遷移（例: A が却下した直後に B の公開が後勝ちして
  `Rejected→Published` が成立）を防げなかった。`FaqRepository.updateStatus` の契約を
  `updateStatus(id, {from, to}, tenantId): Promise<boolean>` に変更し、期待する現在状態
  `from` を where 条件に含めた原子的更新（0 件更新なら `false`）にした。ドメイン遷移表
  （`isValidFaqTransition`）による from→to の妥当性検証は従来どおり Server Action 側の
  責務で、アダプタは「読んだときの状態のまま変わっていないこと」だけを保証する
  （楽観的同時実行制御。incident-insight の ConcurrencyToken ピンと同じ考え方）。
  競合時は日本語の競合エラーを throw し、業種テンプレ投入（`tenant-provisioning.ts`）は
  更新失敗時にトランザクション全体を失敗させる（fail-closed）。
- **状態変更ボタンの二重送信・未捕捉エラーの解消**: `/faq` の「公開する/却下/非公開にする」
  は素の `<form action={updateFaqStatus.bind(...)}>` で、送信中もボタンが押せるうえ
  アクションの throw を誰も捕捉せず（`src/app` に error boundary も無い）、二重クリックや
  競合エラーでページ全体が未処理エラー画面に落ちていた。送信中の無効化とその場のエラー表示
  （`role="alert"`）を備えた `FaqStatusButton` クライアントコンポーネントに置き換えた
  （`FaqInlineForm` が既に持つ「捕捉して表示する」パターンの踏襲）。あわせて
  `FaqInlineForm` のエラー表示にも他フォームと同じ `role="alert"` を付与した（§7 a11y）。
- **エラーメッセージの用語簡素化対応**: 遷移不可メッセージが「FAQ」をハードコードしていた
  ため、他のメッセージと同じく mode-aware な呼称（`FAQ_TERM_LABELS`。Lite:「よくある質問」）
  を使うようにした（§3.1 の用語簡素化・§6 ラベル一元管理）。
- 回帰テスト: メモリ/Prisma 契約テストに「期待状態が一致しない場合は更新せず `false`」を
  追加し、`faq-actions.test.ts` に TOCTOU 再現（stale 読み取り→競合エラー・禁止遷移不成立）
  の回帰テストを追加した。
- `/code-review ultra` 指摘反映: 競合エラー時は `FaqStatusButton` が `router.refresh()` で
  最新状態を取り直す（エラー時は Server Action の `revalidatePath` に到達せず、古いボタンが
  画面に残り続けるため）。0 件更新時は再読込して「行が消えた（見つかりません）」と
  「状態が変わった（競合）」を切り分けて案内する。遷移不可メッセージは「候補または公開済みの
  FAQ候補のみ」という自己矛盾した文言を避け、状態非依存の「現在の状態では実行できない操作です」
  に変更した。
- 既知の残課題（別スコープ）: `TicketRepository.updateStatus`/`markEscalated` にも同型の
  check-then-act 窓が残っており（`updateTicketStatus` は読み取り → `isValidTransition` → 無条件
  `updateMany`）、本フォローアップで導入した `{from, to}` 条件付き更新の契約を将来チケット側にも
  適用する。また、Server Action の throw メッセージは本番ビルドで Next.js によりマスクされ得る
  ため、「日本語 Error を throw し呼び出し側が表示する」という現行規約自体の見直し（結果
  オブジェクト返却への移行）はリポジトリ横断の課題として別途扱う。

#### 1.5 フォローアップ（2026-07-15 #2）: SLA 期限の優先度追随と check-then-act 競合のチケット側適用

コードベース監査（既存 フォローアップ群と同じ「済マーク済みの機能を実装から再点検する」観点）で
発見した 2 件のギャップの修正。§1.4 の「既知の残課題」に明記した積み残しの解消も含む。

- **優先度変更後に SLA 期限が再計算されていなかった**: `updateTicketPriority`
  （`src/features/tickets/actions/update-ticket.ts`）は `priority` 列のみ更新し、
  `resolutionDueAt`/`firstResponseDueAt`（`src/lib/sla.ts` の `SLA_RESOLUTION_HOURS_BY_PRIORITY` /
  `FIRST_RESPONSE_HOURS_BY_PRIORITY` から起票時の優先度で一度だけ算出）を一切再計算しないまま
  だった。例えば Low（168 時間窓）のチケットを起票後に High（24 時間窓）へ引き上げても、
  画面の SLA バッジは旧優先度の期限を表示し続け、Pro プランの差別化要因である SLA 管理の
  正確性を損なっていた。`TicketRepository.updatePriority` の契約に `dueDates` 引数を追加し、
  呼び出し側 (`updateTicketPriority`) が新しい優先度と起票日時 (`ticket.createdAt`) から
  再計算した値を一緒に永続化するよう変更した。`resolutionDueAt` は Pro モードのみ再計算する
  （Lite モードの「期限日」は `TicketForm.tsx` で依頼者がフォーム必須項目として手動指定する日付
  であり、優先度と無関係なため上書きしない。§3.1 用語簡素化の Lite 簡易フォーム参照）。
  `firstResponseDueAt` は Lite/Pro どちらも手動上書きの経路が無いため常に再計算する。
- **check-then-act 競合（TOCTOU）の解消をチケット側にも適用**: §1.4 で `FaqRepository.updateStatus`
  に導入した「期待する現在状態 `from` を where 条件に含めた原子的更新（0 件更新なら競合として
  `false`）」の契約を、残課題として明記されていた `TicketRepository.updateStatus` と
  `markEscalated` にも適用した。`updateStatus` は `(id, {from, to}, resolvedAt, tenantId): Promise<boolean>`
  に、`markEscalated` は期待するエスカレーション前の状態 `expectedStatus` を引数に追加した
  `(id, args, expectedStatus, tenantId): Promise<boolean>` に契約を変更し、`updateTicketStatus` /
  `escalateTicket`（`update-ticket.ts`）は `false` が返れば「他の操作と競合したため変更できません
  でした。最新のチケットをご確認ください」を throw する（FAQ 側と同じ日本語文言）。
- 回帰テスト: `tests/data/ticket-repository.contract.ts`（メモリ/Prisma 両アダプタ共有）に
  「期待状態が一致しない場合は更新せず `false`」と「`updatePriority` が `dueDates` も永続化する」
  を追加。`tests/features/update-ticket.test.ts` に `updateTicketPriority` の Pro/Lite モード別
  SLA 再計算と、`updateTicketStatus`/`escalateTicket` の TOCTOU 再現（`store.tickets.get` /
  `repos.tickets.findById` を一時的にモックして「読み取りは古い状態を返すが実際の行は既に別状態」
  を再現）を追加した。

### Phase 2 — 既存チャネルからの取り込み（4 週間）★ 差別化の本丸

- [x] **メール取り込み**: 専用転送アドレス（例: `tenant-abc@inbox.helpdesk-hub.app`）に転送するとチケット化。`POST /api/inbound/email` を Webhook として実装（SendGrid Inbound Parse 形式の multipart / JSON 双方を受理）。テナントは `Tenant.inboundToken`（宛先ローカルパート）で特定、共有シークレット検証＋既知メンバー以外は隔離。純粋パーサ `src/lib/inbound-email.ts` ＋ ユニット/ルートテスト付き
- [x] スレッド継続（`In-Reply-To` ヘッダで紐付け）
- [x] **LINE 公式アカウント連携（β）**: 友だち追加 → メッセージ送信でチケット化、担当者の返信が LINE に返る
- [x] メール通知テンプレートの整備（HTML、日本語、件名規約）
- [x] 「対応すると依頼者にメールで返信が届く」を既定動作に（依頼者がアプリにログインしなくても完結）

#### 2.1 フォローアップ（2026-07-06）: LINE 連携のマルチテナント化

初回実装（PR #170 系列）では 1 デプロイ環境につき 1 テナント / 1 LINE チャネルを
`LINE_CHANNEL_SECRET` / `LINE_TARGET_TENANT_ID` / `LINE_CHANNEL_ACCESS_TOKEN` の環境変数で
決め打ちする β 制約付きで実装した（`src/app/api/inbound/line/route.ts` のコメント参照）。
本アプリはマルチテナント SaaS が前提（§3.3・§5.6）であり、他の全チャネル（メール取り込み・
Slack/Teams/Chatwork 通知・SSO）は既にテナント単位の設定として実装済みのため、LINE 連携だけが
グローバル単一チャネルのままなのは設計上の整合性を欠く。よって本計画を更新し、以下を追加実装する:

- テナント単位の `TenantLineConfig`（channelSecret / channelAccessToken / botUserId）を Prisma
  モデルとして追加し、Port/Adapter（Prisma + メモリ）で管理する。
- Webhook 受信時は LINE が送ってくる `destination`（チャネルの Bot User ID。秘密情報ではない
  公開識別子）で `TenantLineConfig` を引き、そのテナント専用の `channelSecret` で署名検証する
  （メール取り込みの `inboundToken` と同じ「公開識別子でテナントを特定 → 秘密鍵で認証」の設計）。
  署名検証前に `destination` を信用してはいけないため、検証成功までは「該当チャネル設定が
  存在するかどうか」を含め詳細を外部に漏らさない（未設定・不一致のどちらも同一の 401 を返す）。
- 担当者からの LINE 返信 push（`src/lib/line-push.ts`）もテナントの `channelAccessToken` を
  使うよう変更し、環境変数 `LINE_CHANNEL_ACCESS_TOKEN` への依存を廃止する。
- 設定画面（`/settings`、admin 専用・Pro/Enterprise プランのみ）でテナントごとに
  チャネルシークレット・アクセストークン・Bot User ID を登録できるようにする。

この変更により、複数テナントが同時に別々の LINE 公式アカウントを連携できるようになる
（β の「1 テナント 1 チャネル」制約そのものは変わらないが、それがテナントごとに独立して
設定可能になる）。

#### 2.1.1 フォローアップ（2026-07-09）: 連携コード冪等化の DB 永続化

監査で発見したギャップ: 連携コード処理（紐付け成功/競合）の冪等化は起票を伴わないため
`LineMessageRef` 対応表の対象外であり、インプロセス Map（TTL 10分）で代替していた
（`src/lib/line-link-code-dedup.ts`）。この設計は水平スケール環境だけでなく **単一インスタンスでも**、
連携成功直後（TTL 10分以内）にプロセス再起動/デプロイが挟まると冪等化が失われ、再送された
コード文字列がそのまま問い合わせ本文として誤起票され得た。デプロイは日常的に起こりうるため、
これは「水平スケール前提でのみ顕在化する」既知の制約（SSE ブロードキャスタ・レート制限と同種）
とは性質が異なる、優先度の高い実バグと判断し、以下に対応する:

- `LineLinkCodeRef` テーブル（`lineMessageId` 一意・tenantId スコープ不要）を追加し、
  Port/Adapter（Prisma + メモリ）で `wasProcessed` / `markProcessed` を提供する。
- `src/app/api/inbound/line/route.ts` をこの DB 永続化経由に切り替え、インプロセス Map
  実装（`src/lib/line-link-code-dedup.ts`）は削除する。
- 連携コード処理は低頻度（メンバー連携時のみ）のため、旧実装にあった TTL ベースの
  掃除ロジックは持たず、恒久記録として保持する（件数は実運用でも小さい想定）。

#### 2.1.2 フォローアップ（2026-07-12）: メール経由のエージェント返信が初回応答 SLA に反映されていなかった

監査で発見したギャップ: Web フォーム/API 経由のコメント投稿（`POST /api/tickets/[id]/comments`）は
エージェントの初回コメント時に `firstRespondedAt`（初回応答日時。SLA §初回応答期限の判定基準）を
記録するが、メール取り込みのスレッド継続（`POST /api/inbound/email` の `threadTicketId` 分岐、
Phase 2「スレッド継続」）は同じくエージェントが返信して既存チケットへコメント追記する経路
でありながら `markFirstResponded` を一度も呼んでいなかった。「対応すると依頼者にメールで返信が
届く」（Phase 2 チェック項目）の裏側で、エージェント自身がメールで返信する運用（Web 画面を開かず
メールクライアントだけで完結する運用）を採る一人情シスほどこの経路を使う頻度が高く、そうした
テナントほどチケット詳細（Pro モード）の「初回応答期限」バッジが実際には対応済みなのに
「未応答」のまま表示され続け、ダッシュボードの品質メトリクス（平均初回応答時間）からも該当
チケットが永久に除外される、という体験だった。

- `src/app/api/inbound/email/route.ts` のスレッド継続分岐に、`comments/route.ts` と同じ
  「エージェントの初回コメントのみ・既に記録済みなら上書きしない」ガード付きで
  `r.tickets.markFirstResponded(...)` 呼び出しを追加した。LINE 取り込み（`inbound/line/route.ts`）
  は常に新規チケットを作成する設計で既存チケットへのコメント追記経路自体を持たないため対象外。
- 回帰テストとして、メールのスレッド継続でエージェントが返信するケースを
  `tests/features/inbound-email-route.test.ts` に追加した（既存のテストは依頼者本人が自分の
  チケットに返信するケースのみで、エージェントが送信者になるケースが一切カバーされていなかった）。

### Phase 3 — オンボーディング & 業種テンプレ（3 週間）

- [x] テナント作成時に **業種テンプレ**（製造業 / 飲食 / 介護 / 不動産 / 士業 / 卸売 など）でカテゴリと「よくある質問」を初期投入
- [x] **Excel インポート**: 既存の問い合わせ管理 Excel を CSV にして取り込み（最低限の列マッピングウィザード）
- [x] チュートリアル動画リンク・サンプルチケット
- [x] ヘルプセンター（このリポジトリ内に Next.js で同梱、SSG）

#### 3.1 フォローアップ（2026-07-10）: CSV インポートに「状況」列が無く、既存の完了済み行を再現できなかった

監査で発見したギャップ: Excel インポートは「最短で Excel から卒業できる」（§0 北極星指標）ための
最重要機能だが、列マッピングウィザード（`SYSTEM_FIELDS`）が対応する列は件名/内容/期限日/優先度/拠点
のみで、状況（ステータス）列が無かった。サーバー側 (`import-tickets.ts`) も常にモードの既定初期
ステータス（Lite: `Open`＝未対応 / Pro: `New`＝新規）で起票していた。実在する「既存の問い合わせ管理
Excel」は月日をまたいで蓄積された台帳であり、対応済み・未対応が混在しているのが通常だが、これを
インポートすると全件が「未対応」になってしまい、本来は完了しているはずの数十〜数百件を admin が
手作業で再度クローズし直す必要があった。これは「最短で卒業」どころか Excel より作業が増える体験で、
Phase 3 のロードマップ上は `[x]` 済みの機能が北極星指標に反する未完成な状態だった。

- `src/lib/constants.ts` に `resolveStatusFromLabel(label, mode)`（`getStatusLabel` の逆写像）と
  `getStatusLabelsForMode(mode)`（エラーメッセージ用の有効ラベル一覧）を追加。Lite/Pro それぞれの
  表示ラベル集合からのみ一致させ、Lite テナントに Pro 専用ラベル（例:「解決済み」）を渡しても
  解決しないようにした（表示と入力の対称性を保つ）。
- `import-tickets.ts` の `validateImportRow` に「状況」列の検証を追加。優先度列と同じ方針で、
  値が現在モードのラベルに一致しなければ静かに既定値へフォールバックさせず、エラー行として記録する
  （タイポや意図しない値を見逃さないため）。
- 完了系ステータス（`getCompletionStatuses(mode)` が返す値）で起票する場合は、インポート時刻を
  解決日時 (`resolvedAt`) として記録する。これまで `CreateTicketInput`（`src/data/ports/
  ticket-repository.ts`）に `resolvedAt` を渡す経路が無かったため、Port とプリズマ/メモリ両
  Adapter に追加した。`update-ticket.ts` の完了判定と同じ `getCompletionStatuses` を共有し、
  「完了」の定義が呼び出し箇所ごとに食い違わないようにしている（§1.1 フォローアップと同じ方針）。
- `CsvImportForm.tsx` のウィザードに「状況」列マッピングを追加（`ColumnMapping` / `PreviewRow` /
  `SYSTEM_FIELDS` / `applyMapping` / `buildPreview` / `buildAutoMapping` / プレビュー表を一貫して
  拡張）。入力値フォーマットのヒントに「画面に表示されている状況の日本語表記と完全に一致させる」
  旨を明記し、事前に何が入力できるかを admin に伝える。

#### 3.2 フォローアップ（2026-07-10）: ヘルプセンターのメール取り込み説明が実装と食い違っていた

監査で発見したギャップ: Phase 3「ヘルプセンター」（`src/app/help/email-integration/page.tsx`）は
「未登録のアドレスからのメールはシステムが受け取りますが、担当者が確認の上で処理する場合があります」
と案内していたが、実装（`POST /api/inbound/email`、§9 の設計）は未知送信者のメールをチケット化せず、
`console.warn` のサーバーログ（admin は通常アクセスできない）を残すだけで `202 quarantined` を返して
即座に無視する。担当者が後から確認できる隔離キュー等は存在しない。この案内を信じた admin は
「登録し忘れたメンバーからの問い合わせも、いずれ誰かが拾ってくれる」と誤解しうるが、実際にはメールは
チケットとしては跡形もなく消え、送信者にも管理者にも失敗が一切通知されない。Excel 運用より問い合わせを
取りこぼしやすくなるという、北極星指標（§0）に反する体験だった。

- ヘルプセンターの注意事項を実装どおりの内容に修正: 未登録アドレスからのメールはチケット化されない
  こと、社外の方や未登録メンバーからの問い合わせは登録済みメンバー経由で転送するか先にメンバー登録
  （招待）を行う必要があることを明記した。
  `/code-review ultra` 指摘対応: 当初「記録も残らない」と書いたが、実際にはサーバーログには残るため
  過大な言い切りだった。admin から見える結果（チケット化されない）に絞った文言にした。
- 隔離キューの永続化・admin 向け一覧画面の新設は本フォローアップのスコープ外とした（実装を伴う
  中規模の変更になるため、まず実態と食い違う案内を止めることを優先した）。将来的に必要性が高まれば
  別途フォローアップとして着手する。

#### 3.2 フォローアップ再訪（2026-07-12）: 隔離キューの永続化・admin 向け一覧画面

上記フォローアップで「スコープ外」として残していた隔離キューの永続化を実装する。

- `QuarantinedEmail` モデル（`prisma/schema.prisma`）を追加し、`POST /api/inbound/email` が
  隔離する 5 箇所すべて（プランゲート・送信元認証失敗・未知送信者・スレッド追記権限なし・月間上限
  到達）で `reason`（`QuarantineReason` enum）・送信者アドレス/氏名・件名を記録する。本文は保存しない
  （件名・送信者だけで admin が「招待し忘れたメンバーか」「スパムか」を判断できるため、`SettingsAuditLog`
  が値そのものを記録しない設計と同じ範囲最小化の方針）。
- Port/Adapter（Prisma + メモリ）を `src/data/ports/quarantined-email-repository.ts` に追加し、
  Composition Root に組み込んだ。記録失敗は本来の 202 応答に影響させない独立した try/catch
  （§4.2 の監査ログ書き込みと同じ方針）。
- 管理者専用の `/quarantine` 一覧画面を新設（`role === 'admin'` の直接比較。/audit と同じ RBAC）。
  プランゲートは設けない: Free プランでの隔離 (`plan_gate` 理由) を admin 自身が確認できることは
  「なぜメールが取り込まれないか」に気づく導線として有用なため、全プランで閲覧できるようにした。
  サイドバーに「隔離メール」ナビ項目を追加。
- ヘルプセンター（`src/app/help/email-integration/page.tsx`）の注意事項を、隔離メールが
  「隔離メール」画面から確認できる旨に更新した。

#### 3.3 フォローアップ（2026-07-11）: CSV エクスポートに「内容」列が無く、往復でチケット本文が失われていた

監査で発見したギャップ: §3.1 フォローアップで CSV インポートに「内容」（本文）列を追加したが、
CSV エクスポート（`GET /api/tickets/export`）側のヘッダー・データ行には「内容」列が存在しなかった。
「最短で Excel から卒業できる」（§0 北極星指標）ためには、エクスポートしたデータを Excel で編集して
そのまま再インポートできる往復性が前提になるが、admin がチケット一覧をエクスポートして見直し・
バックアップ・別テナントへの移行のために編集して再インポートすると、全チケットの本文（問い合わせの
具体的な内容）が空文字になって作成し直される（インポートは常に新規行として作成するため、元の本文は
復元不能）。これは §3.1 フォローアップが「状況」列で解消したのと同種の非対称なギャップだった。
あわせて「カテゴリ」列はエクスポートには存在するがインポート側に読み取りが無く、同じ往復性の欠如が
あったため合わせて解消する。

- `ticketsToCsv`（`src/app/api/tickets/export/route.ts`）のヘッダー・データ行に「内容」列
  （`t.body`）を「件名」の直後に追加した（CSV インジェクション対策は既存の `buildCsvString` の
  `escapeCSVCell` が担うため追加対応不要）。
- CSV インポート（`import-tickets.ts` / `CsvImportForm.tsx`）に「カテゴリ」列を追加した。拠点列
  （§4.1 系フォローアップとは別に既存実装済みだった名前解決パターン）と同じ設計を踏襲し、テナントの
  カテゴリ一覧から名前解決する。テナントに存在しないカテゴリ名は無言でフォールバックさせず、拠点と
  同じくエラー行として記録する。
  `/code-review ultra` 指摘対応 (2026-07-11): 拠点は Lite/Pro 両モードで使える概念だが、カテゴリは
  `TicketForm.tsx` の `{!isLite && (...)}` や `POST /api/tickets` の
  `effectiveCategoryId = mode === 'lite' ? null : ...` が示すとおり Pro モード専用の概念であり、
  「拠点と同じ設計」をそのまま適用すると Lite テナントでも CSV 経由でカテゴリが設定できてしまう
  （Web フォーム/メール/LINE 取り込みの他の全経路と矛盾する）回帰があった。Lite テナントでは
  「カテゴリ」列に値があっても名前解決自体を行わず、常に `categoryId: null` で起票するよう修正した
  （拠点とのモード差はここが唯一の相違点で、それ以外の名前解決・エラー記録ロジックは共通ヘルパー
  `extractOptionalCell` / `buildNameToIdMap` / `resolveNameToId` として実際にコードも共有している）。

  なお「解決期限」（エクスポート列）と「期限日」（インポート列。`YYYY-MM-DD` 厳密形式)
  は列名・日付フォーマットの両方が一致しておらず、本フォローアップ以前から CSV 往復ができない
  既知のギャップとして残っている（本フォローアップのスコープ外。別途フォローアップとして扱う）。

#### 3.4 フォローアップ（2026-07-11 #2）: CSV エクスポートの期限日列が名前・書式ともインポートと一致せず往復できなかった

監査で発見したギャップ: §3.3 フォローアップの脚注で挙げた既知のギャップに対応する。CSV エクスポート
（`GET /api/tickets/export`）は解決期限を列名「解決期限」・`formatDateJP`（ja-JP ロケール、例
「2026/3/31」。非ゼロ埋め）で出力していたが、CSV インポート（`import-tickets.ts`）は列名「期限日」・
`parseDateLocal` による `YYYY-MM-DD` 厳密形式のみを受け付ける。列名が一致しないため
`CsvImportForm.tsx` の自動マッピング (`buildAutoMapping`) は「解決期限」列を「期限日」フィールドへ
一切対応付けず、仮に admin が手動でマッピングしても書式不一致で「期限日の形式が正しくありません」
エラーになり全行が取り込めない。§3.3 が「件名」「内容」「カテゴリ」で実現した往復性が、期限日
だけ欠けたままだった（§0 北極星指標「最短で Excel から卒業できる」に反する）。

- `src/lib/format-date.ts` に `formatDateISO(date)`（JST の `YYYY-MM-DD`。`en-CA` ロケールが
  ゼロ埋め済みの `yyyy-mm-dd` を返す性質を利用。`endOfDayJST` と同じ手法）を追加した。
- `ticketsToCsv`（`src/app/api/tickets/export/route.ts`）のヘッダーを「解決期限」→「期限日」に、
  値のフォーマットを `formatDateJP` → `formatDateISO` に変更し、インポート側が既に使っている
  列名・書式にエクスポート側を合わせた（インポート側の `parseDateLocal` 実装やエラーメッセージの
  案内文言（YYYY-MM-DD 形式）は既に正しかったため変更していない）。
- CSV 上の列名「解決期限」はチケット詳細画面 (`/tickets/[id]`) の表示ラベルとしては引き続き使われて
  おり、この変更は CSV の列名のみを対象とする（画面表示の用語は変更していない）。

#### 3.5 フォローアップ（2026-07-13）: メール取り込みの新規起票がエージェントへアプリ内通知されていなかった

監査で発見したギャップ: 新規問い合わせの入口チャネル（§5.3 入口チャネルの Adapter 化）は Web フォーム・
LINE・CSV インポート・メールの 4 系統あるが、「新規起票をエージェントへ即時に気づかせる」アプリ内通知
（`Notification` テーブルへの `type: 'imported'` 書き込み ＋ SSE での未読件数即時配信）は LINE 取り込み
（`processLineEvent`）と CSV インポート（`import-tickets.ts`）にしか実装されておらず、メール取り込み
（`POST /api/inbound/email`）だけが欠けていた。メール起票が担当者に伝わる経路は Slack/Teams/Chatwork
通知（`notifyNewTicketOutbound`）だけだったが、これはテナントごとに個別設定が必要な任意のオプトイン
機能であり、未設定のテナント（§1 の「町工場の事務員」ペルソナのように最小構成で始める中小企業ほど
起こりやすい）では、メールで届いた問い合わせに誰も気づけないまま `/tickets` を手動で開くまで放置され
得た。

- `src/app/api/inbound/email/route.ts`: 新規起票確定後（重複判定の直後、Slack 等の外部通知より前）に、
  `repos.users.listAgents(tenant.id)` でテナント内の全エージェントを取得し、送信者自身がエージェントなら
  本人以外へ、依頼者からの起票なら全エージェントへ `type: 'imported'` の通知を作成する。LINE 取り込みの
  `notifyTargets` 判定・`Promise.allSettled` による部分失敗許容・`broadcastUnreadCountToMany` での SSE
  即時配信を、そのまま同じ形で踏襲した（通知失敗はログのみでチケット起票自体は成功のまま継続する）。
- `tests/features/inbound-email-route.test.ts`: 新規起票時にエージェント宛の `imported` 通知が作成される
  ことを検証する回帰テストを追加した。

#### 3.6 フォローアップ（2026-07-14）: CSV エクスポートの「起票者」列が往復せず、常にインポート実行者に付け替えられていた

監査で発見したギャップ: §3.3/§3.4 フォローアップで「件名」「内容」「カテゴリ」「期限日」の CSV
往復性を解消したが、CSV エクスポート（`GET /api/tickets/export`）が出力する「起票者」列
（`t.creator?.name`）に対応する読み取りが CSV インポート（`import-tickets.ts`）側に一切存在せず、
インポートされる全チケットの `creatorId` は常にインポートを実行した admin のセッション ID に
ハードコードされていた。これは §3.1/§3.3/§3.4 と同種の CSV 往復性の欠落だが、「起票者」列は
表示専用の他の列と異なり、依頼者本人がそのチケットを見られるかどうか
（`src/app/(app)/tickets/[id]/page.tsx` の `!isAgent && ticket.creatorId !== session.user.id`
による 404）と、ステータス/優先度変更時の通知の宛先（`update-ticket.ts`）の両方を左右するため、
影響がより深刻だった。admin がバックアップ・見直し・他テナントへの移行目的でチケットを
エクスポートし、編集して再インポートする（§0 北極星指標「最短で Excel から卒業できる」が
前提とする往復ワークフロー）と、元の依頼者（例: §1.2 の現場リーダー鈴木さん）が自分の
問い合わせを一覧・詳細のどちらからも見られなくなり、以後の進捗通知も届かなくなる回帰だった。

- `src/data/ports/user-repository.ts` に `listByTenant(tenantId)` を追加（Prisma + メモリ両
  Adapter で実装）。起票者はエージェントに限らず依頼者もなり得るため、既存の `listAgents`
  （agent/admin のみ）では名前解決できず、ロールを問わない一覧取得が別途必要だった。
- `import-tickets.ts` に「起票者」列（`headers.indexOf('起票者')`）を追加し、拠点/カテゴリ/
  担当者と同じ名前解決パターンを踏襲した。同姓同名のメンバーが複数存在する場合に Map の
  キー衝突でどちらか一方へ無言で misassign されるのを防ぐ重複検出ロジックは、担当者列の実装と
  完全に同型だったため `buildNameToIdMapWithDuplicates` として抽出し両者で共有した（§6 DRY:
  2 箇所目の重複が生じた時点で共通化する方針）。列が無い/セルが空の行は従来どおりインポート
  実行者を起票者にする（後方互換）。
- `CsvImportForm.tsx` のウィザードに「起票者」列マッピングを追加し、`ColumnMapping` /
  `PreviewRow` / `SYSTEM_FIELDS` / `applyMapping` / `buildPreview` / `buildAutoMapping` を
  拠点/担当者と同じ形で一貫して拡張した。入力値フォーマットのヒントに「登録済みのメンバー
  （担当者または依頼者）の氏名と完全一致」「空欄ならインポート実行者が起票者になる」旨を明記した。
- `tests/features/import-tickets.test.ts` に依頼者名/エージェント名での解決・列/セル省略時の
  後方互換・存在しない名前のエラー・同姓同名の重複エラー・他テナントの同名ユーザーが解決対象に
  含まれないことの回帰テストを追加。`listByTenant` 自体のテストも
  `tests/data/user-repository.memory.test.ts` と `user-repository.contract.prisma.test.ts` に
  追加した。

#### 3.7 フォローアップ（2026-07-14 #3）: 隔離記録一覧に CSV エクスポートが無く、200 件を超えると古い記録に到達できなかった

監査で発見したギャップ: §3.2 フォローアップ再訪（2026-07-12）で `/quarantine` 画面と
キーセットページネーション（「さらに読み込む」）を新設したが、CSV エクスポートは実装しなかった。
一方 `/audit` 画面は同じ「200 件で打ち切られる一覧を、監査・investigation 目的でまとめて
保管・共有したい」というニーズに対し、§4.2.1（キーセットページネーション追加時点）を経て
§4.2.2 で「現在ページのみ即時ダウンロード」＋「全履歴 CSV エクスポート（`GET
/api/audit/export`）」の 2 段構えまで発展させていた。`/quarantine` はその後継の改善を一切
受けておらず、隔離記録が 200 件を超えるテナントの admin は「登録し忘れたメンバーからの
問い合わせが隔離されていないか」をまとめて確認したり、スパム傾向の証跡として誰かに共有したり
する手段が「さらに読み込む」の手作業以外に存在しなかった。

- `src/features/quarantine/quarantine-csv.ts` に `quarantinedEmailRowsToCsv` を新設し、
  `src/features/audit/audit-csv.ts`（画面とエクスポートルートで列定義を共有する純粋関数）と
  同じ設計を踏襲した。列はメール由来（送信者名・送信元アドレス・件名）と LINE 由来
  （LINE ユーザー ID）の両方を機械可読な別列として持つ（画面表示は 1 セルにまとめているが、
  CSV では往復性より判別しやすさを優先した）。
- `GET /api/quarantine/export` を新設した。`GET /api/audit/export` と同じキーセットカーソル
  前進ループ・`MAX_QUARANTINE_EXPORT_ROWS`（10,000 件）・`assertTenantAdmin` による
  admin 専用ゲート・専用レート制限（3 回/分）を踏襲する。`/quarantine` 画面と同じくプランゲートは
  設けない（Free プランでの隔離を admin 自身が確認できることが「なぜ取り込まれないか」に
  気づく導線として有用なため。§3.2 フォローアップ再訪の方針をそのまま踏襲）。
- `src/features/quarantine/components/QuarantineExportButton.tsx`（`AuditFullExportButton.tsx`
  と同じ設計）を追加し、`/quarantine` 画面ヘッダーに配置した。`/audit` と異なり `/quarantine`
  には「現在ページのみ即時ダウンロード」ボタンが元々存在しなかったため、全履歴エクスポートの
  1 ボタンのみを追加した（無かった機能を 2 つ同時に増やすと変更のスコープが広がるため、
  §4.2.2 の 2 段構えのうち今回不足していた「全履歴」側のみを追加する）。
- `tests/features/quarantine-export-route.test.ts` に `tests/features/audit-export-route.test.ts`
  と同じ構成（複数ページに跨る集計・ちょうど上限件数での誤 truncated 防止・RBAC・
  プランゲート無し・レート制限・未認証）の回帰テストを追加した。
- `/code-review ultra` 指摘対応: 当初は `GET /api/quarantine/export` を `GET /api/audit/export`
  からキーセットカーソル前進ループ・打ち切り誤検知防止・CSV レスポンスヘッダー組み立てまで
  丸ごと複製する形で実装していたが、これは同一ロジックの 2 箇所目の複製であり
  （`fetch-audit-feed-page.ts` や `rate-limit.ts` の `checkRateLimit` が同種の重複を「2〜3
  箇所目で共通化する」方針（§6 DRY）で解消してきた前例と同じ状況）、看過できないと判断した。
  `src/lib/cursor-csv-export.ts` に `collectCursorPaginatedRows`（カーソル前進ループ + 誤検知
  防止）・`buildCsvExportResponse`（ファイル名の JST 日付付与 + 打ち切り時ヘッダー）を抽出し、
  `GET /api/audit/export` 側もこの共通ヘルパーを使うよう改修した（新規実装だけでなく、複製元の
  既存実装も併せて共通化する）。あわせて `quarantine-csv.ts` の docstring が「画面
  (page.tsx) とエクスポートルートの両方がこの関数を共有する」と audit-csv.ts の説明を
  そのまま流用していたが、`/quarantine` 画面は表を直接描画しておりこの関数を消費していない
  ため、実態と食い違う記述を修正した。

#### 3.8 フォローアップ（2026-07-15 #3）: CSV エクスポートの「起票日時」列が再インポートに対応していなかった

コードベース監査で発見したギャップの修正。§3.1/§3.3/§3.4/§3.6 で解消してきた CSV 往復性の
ギャップと同種で、これらのフォローアップでは見落とされていた列。

- **問題**: `GET /api/tickets/export` は「起票日時」列を出力する
  （`src/app/api/tickets/export/route.ts`）が、CSV インポート（`CsvImportForm.tsx` の
  `SYSTEM_FIELDS` / `src/features/tickets/actions/import-tickets.ts`）には対応する列が無く、
  インポートされた行の `createdAt` は常にインポート実行時刻 `now` で上書きされていた
  （§0 の北極星指標「エクスポートしたデータを Excel で編集してそのまま再インポートできる
  往復性」に反する）。§1.1 の「町工場の事務員 田中さん」ペルソナが数ヶ月分の既存 Excel 台帳を
  移行する典型シナリオで、全行の起票日時がインポート実行時の瞬間に付け替えられ、実際にいつ
  問い合わせがあったかの情報が失われていた。
- **修正**: エクスポート側は再パース可能な `'YYYY-MM-DD HH:mm:ss'`（JST・ゼロ埋め済み）形式の
  `formatDateTimeISO` に変更（従来の `formatDateTimeJP` は ja-JP ロケールの非ゼロ埋め表示で
  再パース不可。期限日列を `formatDateJP` → `formatDateISO` に変更した §3.4 と同型の対応。
  「更新日時」列は再インポート対象ではないため `formatDateTimeJP` のまま維持）。インポート側は
  対になる `parseDateTimeJST` を `src/lib/format-date.ts` に追加し、「起票日時」列があれば
  `createdAt` として使う（無ければ従来どおりインポート時刻）。未来日時はエラーとして拒否する
  （`resolvedAt`/`firstRespondedAt` はインポート時刻で近似するため、起票日時が未来だと
  「解決に負の時間がかかった」矛盾したデータになるため）。あわせて `firstResponseDueAt` の
  算出基準もインポート時刻ではなく起票日時（未指定ならインポート時刻）に変更し、過去日で
  起票日時を指定した行の初回応答期限が実際の起票日から大きくズレる副作用も解消した。
- 回帰テスト: `tests/format-date.test.ts` に `formatDateTimeISO`/`parseDateTimeJST` の往復・
  境界値テストを追加。`tests/features/import-tickets.test.ts` に起票日時列の読み取り・
  未指定時のフォールバック・不正形式/未来日時のエラー化を追加。
  `tests/features/tickets-export-route.test.ts` にインポート側と同じ形式で出力されることの
  回帰テストを追加した。

### Phase 4 — マネタイズと運用（継続）

- [x] サブスク課金（Stripe Billing）: Free / Standard / Pro の 3 段階
- [x] 監査ログ / バックアップ自動化（`scripts/backup-db.sh` ＋ スケジュール CI `.github/workflows/backup.yml`。pg_dump + 世代管理。手順は `docs/backup.md`）
- [x] 多店舗・多拠点対応（テナント内サブグループ）
- [x] Slack / Chatwork / Microsoft Teams 通知 Adapter
- [x] Enterprise プラン（§6.1 料金表）: 無制限 + 監査強化。`SubscriptionPlan` に `enterprise` を追加
- [x] SSO（SAML）— Enterprise 限定（`isSsoAllowed`）。テナント単位の IdP 設定 + SP メタデータ/ACS/ログイン エンドポイント（`/api/auth/sso/<tenantId>/*`）。署名・Issuer・Audience・期限を検証（`@node-saml/node-saml`）。既存メンバーのみログイン許可（JIT 無効）

#### 4.1 フォローアップ（2026-07-09）: ダッシュボードの拠点フィルタ

監査で発見したギャップ: 多店舗・多拠点対応（`locationId`）はチケットの作成・一覧絞り込み・CSV
入出力までは配線済みだったが、Pro モードのダッシュボード集計（`dashboardStats` / `qualityMetrics`）
は `locationId` を一切考慮しておらず、複数拠点のテナントでも常に全拠点合算の数値しか見えなかった。
これは多拠点対応の狙い（拠点ごとの負荷・対応品質を把握する）を満たしていない未完成の機能だった。

- `TicketRepository.dashboardStats` / `qualityMetrics` の引数に `locationId?` を追加し、
  Prisma / メモリ両アダプタで対応（Prisma 側は `qualityMetrics` の生 SQL 3 本にも
  `since` と同じ「NULL なら条件を無視する」パターンで追加）。
- ダッシュボード画面にテナントの登録拠点一覧から選ぶピル型フィルタを追加（`?locationId=`）。
  拠点が 1 つも登録されていないテナントには表示しない。

#### 4.1.1 フォローアップ（2026-07-10）: Lite ダッシュボードには拠点フィルタが効いていなかった

監査で発見したギャップ: §4.1 で拠点フィルタを実装した際、対象は Pro モードのダッシュボードのみで、
Lite（既定モード。§3.1）の簡易ダッシュボード（`LiteDashboard`）には配線されていなかった。多拠点
対応は `locationId` を持てば Lite/Pro を問わず有効であり（プランゲートの対象ではない）、実際に
多拠点対応する SMB テナントの大半は既定の Lite モードで運用するため、§4.1 で埋めたはずのギャップ
が最も使われる画面には残ったままだった。

- 拠点フィルタのピル UI（`/dashboard` の `Link` 群）を `LocationFilterPills` として切り出し、
  Pro/Lite 両ダッシュボードで共有する（§6 DRY: 同一マークアップの 2 箇所目の複製を避ける）。
- `LiteDashboard` に `locations` / `selectedLocationId` を渡し、「自分の未対応」「期限切れ」の
  集計フィルタ（`baseFilter`）に `locationId` を差し込む。拠点が 1 つも登録されていないテナントには
  Pro 側と同様にピル自体を表示しない。
- `/code-review ultra` 指摘対応: UI（ピル）は `LocationFilterPills` として共通化した一方、
  URL の `locationId` が当該テナントの拠点一覧に実在するかを検証するバリデーション（三項演算子）は
  Pro/Lite 両ブランチにそのまま書き写しており、UI とロジックで共通化の徹底度が食い違っていた。
  `resolveSelectedLocationId` として同様に切り出し、両ブランチで共有するよう揃えた。

#### 4.2 フォローアップ（2026-07-09）: 設定変更の監査ログ記録

監査で発見したギャップ: 監査ログ画面（`/audit`、Pro/Enterprise 限定）は `TicketHistory`（チケットの
状態/優先度/担当者/エスカレーション変更）しか表示しておらず、SSO 設定・LINE 連携設定・通知チャネル
（Slack/Teams/Chatwork）設定の変更が監査対象から漏れていた。「誰が IdP 証明書を差し替えたか」
「誰が Webhook URL を変更したか」を後から追えず、Enterprise の「監査強化」を謳う料金プラン
（§6.1）の実態と乖離していた。

- `SettingsAuditLog` テーブルを新設し、Port/Adapter（Prisma + メモリ）で `record` / `findAllByTenant`
  を提供する。`TicketHistory` と異なり値の変更前後（oldValue/newValue）は記録しない設計にした
  （これらの設定は channelSecret / idpX509Cert / chatworkApiToken のような秘匿情報を含むため、
  変更前後の値をログに残すこと自体が §9「秘密情報をログに残さない」方針に反する）。
  「誰が・いつ・何をしたか（action）」だけを記録する。
- `update/delete-sso-config.ts`・`update/delete-line-config.ts`・`update-notification-channels.ts`
  の成功時に `repos.settingsAudit.record(...)` を呼ぶ。認可ゲート（`assertTenantAdmin` 等）の
  戻り値に `userId` を追加し、各アクションが「誰が実行したか」を渡せるようにした。
- `/audit` 画面は `TicketHistory` と `SettingsAuditLog` を統一行型（`AuditFeedRow`）にマージし、
  新しい順に並べて表示・CSV エクスポートする。設定変更行はチケット列を持たないため「−」表示にする。

#### 4.2.1 フォローアップ（2026-07-10）: 監査ログ画面が古い行に一切到達できず、CSV エクスポートも切り詰められていた

監査で発見したギャップ: §4.2 で `/audit` 画面を新設した際、`TicketHistory` と `SettingsAuditLog` を
マージして新しい順に並べ、上限 200 件（`PAGE_LIMIT`）に切り詰めて表示していたが、ページネーション UI
が一切無かった。§4.2/§4.3/§4.4 は繰り返し「SSO 証明書変更」「テナントモード変更」「Stripe 起因の
自動ダウングレード」等を「後から追えるように」監査ログへ記録する意義を説明してきたが、チケットの
状態変更（`TicketHistory`）が高頻度に発生するテナントでは、それらが数日でマージ後の上位 200 件から
押し出されてしまう。`SettingsAuditLog` 自体は DB に残り続けるにもかかわらず、画面からもその唯一の
出口である CSV エクスポート（表示中の 200 件のみを書き出す）からも一切到達できなくなり、§4.2〜§4.4
が「後から追える」と説明してきた前提が実際には成立しないケースがあった。

- `TicketHistory` / `SettingsAuditLog` の両 Port（`HistoryListFilter` / `SettingsAuditLogListFilter`）
  に `before?: AuditPaginationCursor` を追加し、Prisma/メモリの計 4 アダプタでキーセットカーソル
  として実装した。2 種類の時系列をマージ表示する都合上、`offset` だけでは「マージ後の何件目か」を
  正しく指定できない（両ソースの時間分布が偏るとページがずれる）ため、両リポジトリに同じ境界値を
  渡す方式を採用した。
- `/audit` 画面に `?before=` の「さらに読み込む」リンクを追加した。1 ページの最後（最も古い行）を
  次カーソルとして渡すことで、古い行まで無制限に辿れるようにした。
- 不正な `before` クエリ値（壊れた日付文字列等）は §9 の入力検証方針に従い、カーソル無し（最新から
  表示）へ安全側でフォールバックする。
- CSV エクスポートは今回のスコープでは「現在表示中のページ分のみ」のまま据え置いた（全履歴の
  一括エクスポートは別途のフォローアップ課題とする）。「さらに読み込む」で必要な期間まで遡ってから
  エクスポートする運用を想定している。
- `/code-review ultra` 指摘対応 (2026-07-10): 当初 `before` を `createdAt` 単独のカーソルにして
  いたが、複数の独立レビューエージェントが収斂して指摘: 同一ミリ秒に複数行が記録された場合
  （バルク CSV インポート・同時多発の設定変更等）、ページ境界をまたぐ同時刻の行の一部が
  `slice(0, PAGE_LIMIT)` で切り捨てられ、次ページの `createdAt <` 判定でも除外されるため、
  その行に画面からもエクスポートからも永久に到達できなくなる回帰があった (本フォローアップ自身が
  解決しようとしていた問題の再発)。`id` を第 2 キーに持つ複合カーソル (`AuditPaginationCursor`,
  `src/data/ports/audit-pagination.ts`) に変更し、Prisma は `OR: [{createdAt: {lt}}, {createdAt, id: {lt}}]`
  ＋ `orderBy: [{createdAt:'desc'},{id:'desc'}]`、メモリアダプタは共通ヘルパー
  `isBeforeAuditCursor`（`src/data/adapters/audit-pagination.ts`）で同じ比較規則に揃えた。
  Prisma 契約テスト（`tests/data/{ticket-history,settings-audit-log}-repository.contract.prisma.test.ts`）
  にも同一 createdAt の行を直接投入する回帰テストを追加した。
- `/code-review ultra` 再指摘対応 (2026-07-10): 上記の `id` 複合カーソルにも一段深い不備が
  あった。`TicketHistory` と `SettingsAuditLog` は id の採番元が別々のテーブルであり、
  「まだ 1 件も表示していないテーブル」の id を、たまたま先に表示された側のテーブルの id と
  直接大小比較すると、表示順序とは無関係な理由で誤って除外されうる（例: `TicketHistory` 側を
  全件出し切った直後にカーソルを取った場合、`SettingsAuditLog` 側は 1 件も表示していないのに、
  その id が偶然カーソルの `TicketHistory` の id より大きいというだけで次ページから漏れる）。
  カーソルに `kind`（`'ticket' | 'settings'`。マージ順序は `'ticket'` が `'settings'` より必ず
  先、という規約を新設）を追加した 3 要素カーソルに変更し、各リポジトリのクエリを
  「カーソルが自テーブル由来なら通常どおり id で絞る／他テーブル由来なら、マージ順序上
  『まだ表示していない』側は同時刻の行を id を無視して全件対象にし、『表示し終えた』側は
  同時刻の行を全件除外する」の 3 分岐に変更した。`/audit` 画面のマージ用ソートも、配列の
  連結順序と `Array.sort` の安定性という暗黙の前提に頼らず、`kind` による明示的なタイブレークに
  書き換えた。純粋な比較ロジックは `tests/data/audit-pagination.test.ts` として単体テストを新設し、
  Prisma 契約テストにもテーブルをまたぐ境界条件（cursor が他テーブル由来のケース）を追加した。

#### 4.2.2 フォローアップ（2026-07-12）: 監査ログ CSV エクスポートが全履歴の一括出力に対応していなかった

監査で発見したギャップ: §4.2.1 で「さらに読み込む」によるキーセットページネーションを追加したが、
CSV エクスポート（`AuditExportButton`）は据え置きのコメントで明記していたとおり「現在表示中の
ページ分のみ」を書き出すクライアント側処理のままだった。§4.2〜§4.4 が繰り返し「後から追えるように」
と説明してきた監査ログを、admin が実際に監査・棚卸しの目的で一括エクスポートしたい場合、
`PAGE_LIMIT`（200 件）を超えるテナントでは「さらに読み込む」を手作業で何度も辿ってから毎回
エクスポートし直し、手元で複数の CSV を結合する必要があり、実務上ほぼ使えない状態だった。

- `/audit` 画面のマージ・カーソル前進ロジック（`TicketHistory` + `SettingsAuditLog` を取得して
  マージ・ソートする処理）を `fetchAuditFeedPage`（`src/features/audit/fetch-audit-feed-page.ts`）
  に抽出し、画面と新設のエクスポートルートの両方が共有するようにした（§6 DRY）。
- `GET /api/audit/export` を新設し、キーセットカーソルをサーバー側で繰り返し前進させて
  `MAX_AUDIT_EXPORT_ROWS`（10,000 件。`GET /api/tickets/export` の `MAX_EXPORT_ROWS` と同じ考え方）
  まで全ページを蓄積してから 1 つの CSV として返す。admin 専用（`role === 'admin'` 直接比較）・
  Pro/Enterprise プランゲート・専用レート制限（3 回/分。複数ページの DB 読み取りを伴う重い操作の
  ため通常の CSV エクスポートより厳しくした）をサーバー側で強制する。
- CSV 行への変換ロジックも `auditFeedRowsToCsv`（`src/features/audit/audit-csv.ts`）に抽出し、
  現在ページのみをダウンロードする既存の `AuditExportButton` と新設ルートの両方で共有する。
- `/audit` 画面に「全履歴をCSVエクスポート」ボタン（`AuditFullExportButton`）を追加。既存の
  「現在ページのみ即時ダウンロード」ボタンは、追加のリクエスト無しで素早く確認したい用途向けに
  残した。

#### 4.3 フォローアップ（2026-07-09）: 監査ログ対象の拡大（テナントモード・拠点・転送先アドレス）

監査で発見したギャップ: §4.2 で `SettingsAuditLog` を新設した際、対象を SSO/LINE/通知チャネル設定の
変更に限定していたが、同じ「管理者による組織設定の変更」であるテナントの Lite/Pro モード切替
（`update-tenant-mode.ts`）・拠点の作成/更新/削除（`create/update/delete-location.ts`）・メール取り込み
転送先アドレスの再発行（`regenerate-inbound-token.ts`）は監査対象から漏れたままだった。「誰がいつ
Pro モードに切り替えたか」「誰が拠点を削除したか」を後から追えず、§4.2 で埋めたはずのギャップの
一部が残っていた。

- `SettingsAuditAction`（`prisma/schema.prisma` / `src/domain/types.ts`）に
  `tenant_mode_update` / `location_create` / `location_update` / `location_delete` /
  `inbound_token_regenerate` の 5 種を追加し、`src/lib/constants.ts` の
  `SETTINGS_AUDIT_ACTION_LABELS` に対応する日本語ラベルを追加した。
- 上記 5 アクションの成功時に `repos.settingsAudit.record(...)` を呼ぶ（§4.2 と同じ「監査ログの
  書き込み失敗は本来の操作の成否に影響させない」独立した try/catch パターン）。
- oldValue/newValue を記録しない設計（§4.2 参照）は据え置き。これらの操作は秘匿情報を含まないが、
  一貫性のため §4.2 と同じ「誰が・いつ・何をしたか」のみを記録する粒度に揃えた。

#### 4.4 フォローアップ（2026-07-10）: Stripe 自動ダウングレードによるモード変更が監査ログに残らない

監査で発見したギャップ: §4.3 で `tenant_mode_update` アクションを追加した際は、管理者が手動で
モードを切り替える経路（`update-tenant-mode.ts`）にしか `recordSettingsAudit(...)` を仕込んでいな
かった。しかし `tenant.mode` はもう 1 箇所、Stripe Webhook（`applyPlanChange` の `shouldResetMode`）
からも強制的に `pro` → `lite` へ書き換えられる（サブスク解約・ダウングレードで Pro モード対象外の
プランに落ちたとき）。この経路は監査ログに一切記録されておらず、「誰がいつ Pro モードに切り替えた
か」を後から追えるはずだった §4.3 の意図が、Stripe 起因の変更に対しては満たされていなかった。
管理者から見ると、ある日 SLA・エスカレーション・7 ステータスが突然使えなくなったのに `/audit` を
見ても理由が分からない、という体験になっていた。

- この変更はユーザー操作ではなく Stripe イベント起因のシステム操作であり、操作した「誰か」が
  存在しない。`SettingsAuditLog.actorId` を `String` から `String?`（nullable）に変更し、
  `actor` リレーションも任意にするマイグレーション
  （`20260710000000_make_settings_audit_actor_nullable`）を追加した。
- `actorId = null` を「システムによる自動変更」として扱い、一覧表示時は
  `SETTINGS_AUDIT_SYSTEM_ACTOR_NAME`（`src/lib/constants.ts` に一元管理）に解決する
  （データ不整合を表す既存の「不明」フォールバックとは意味を分ける）。
- `src/app/api/webhooks/stripe/route.ts` の `applyPlanChange` を、`uow.run(...)` から
  `shouldResetMode` の真偽値を受け取れるよう変更し、`true` のときだけトランザクション確定後に
  `recordSettingsAudit({ tenantId, actorId: null, action: 'tenant_mode_update', ... })` を呼ぶ
  （§4.2/§4.3 と同じ「監査ログの書き込み失敗は本来の処理の成否に影響させない」独立した扱い）。
- `/code-review ultra` 指摘対応: `actorId` を必須から任意に変えると、Prisma が推論する外部キーの
  参照アクション既定値も `Restrict`（必須リレーション）から `SetNull`（任意リレーション）に変わる。
  当初のマイグレーションは `ALTER COLUMN ... DROP NOT NULL` のみで既存の `ON DELETE RESTRICT` 制約
  （`20260709020000_add_settings_audit_log` で作成）をそのまま残しており、
  `schema.prisma` が implicit に期待する `SetNull` と実 DB の制約が食い違ったまま
  `prisma migrate deploy` されてしまう不備があった。CI は `prisma db push`（schema.prisma を直接
  適用）でテスト DB を作るためこの不整合を検出できず、実際の `migrate deploy` 運用でのみ顕在化する
  類のギャップだった。`npx prisma migrate diff --from-schema-datamodel <変更前> --to-schema-datamodel
  <変更後> --script` で実際に生成される SQL と突き合わせ、外部キーの `DROP`/`ADD` を追加した。

#### 4.5 フォローアップ（2026-07-11）: 招待リンク発行が監査ログの対象から漏れていた

監査で発見したギャップ: §4.2〜§4.3 で `SettingsAuditLog` の対象を SSO/LINE/通知チャネル設定・
テナントモード切替・拠点 CRUD・転送先アドレス再発行まで広げたが、`createInvitation` /
`createInvitationsBulk`（`src/features/settings/actions/`）による招待リンク発行は監査対象から
漏れたままだった。招待リンク発行、特に `agent` 権限での招待は、新しい人物に社内の全チケットへの
アクセス権を付与する操作であり、§4.3 が対象を広げた根拠（「管理者による設定変更」であること）を
そのまま満たす上、SSO 証明書の差し替えなどと同等以上にセキュリティ上重要な操作である。にもかかわらず
`/audit` では「誰が LINE 連携設定を変えたか」は追えても「誰がこのエージェントを招待したか」は
一切追えなかった。

- `SettingsAuditAction`（`prisma/schema.prisma` / `src/domain/types.ts`）に `invitation_issue`
  を追加し、`src/lib/constants.ts` の `SETTINGS_AUDIT_ACTION_LABELS` に日本語ラベルを追加した
  （マイグレーション `20260711000000_add_settings_audit_invitation_issue`）。
- `createInvitation`（単発発行）は発行成功後に `recordSettingsAudit(...)` を 1 回呼ぶ。
- `createInvitationsBulk`（一括発行）は §7.1.1 で追加した CSV 一括招待経路だが、行ごとに
  `recordSettingsAudit` を呼ぶと 30 件のバッチで監査ログが 30 行増えてしまう。`importTickets` が
  200 件のインポートでも通知を 1 通にまとめるのと同じ「バッチ全体で 1 回だけ記録する」方針を踏襲し、
  1 件以上成功した場合のみバッチ終了後に 1 回だけ記録する（全行失敗のバッチは何も権限を付与して
  いないため記録しない）。
- oldValue/newValue を記録しない設計（§4.2 参照）は据え置き。招待メールアドレス自体は個人情報の
  ため、値を監査ログに残さない既存方針とも整合する。

#### 4.6 フォローアップ（2026-07-11 #3）: Pro モードダッシュボードの「クローズ」ステータスが表示されていなかった

監査で発見したギャップ: Pro モードダッシュボード（`/dashboard`）の「ステータス別件数」カード群は
`TicketRepository.dashboardStats` が集計する 7 状態（`New` / `Open` / `WaitingForUser` /
`InProgress` / `Escalated` / `Resolved` / `Closed`）のうち `Closed` の 1 件だけを表示していなかった。
`Closed` は `Resolved` の別名ではなく、`ALLOWED_TRANSITIONS`（`src/domain/ticket-status.ts`）上は
どの状態からも直接遷移できる独立した終了状態であり、`stats.byStatus.Closed` はサーバー側で正しく
取得済みだったにもかかわらず `statCards` 配列に含まれていなかったため、値を取得しては画面表示直前で
捨てていた。エージェントがチケットを Closed にクローズしても、ダッシュボードの一覧性からその件数が
一切見えないという体験だった。

- `src/app/(app)/dashboard/page.tsx` の `statCards` 配列に `{ status: 'Closed', count:
  stats.byStatus.Closed }` を追加し、グリッドの列数を 6→7 件表示に合わせて調整した
  （`sm:grid-cols-3` → `sm:grid-cols-4`、`lg:grid-cols-6` → `lg:grid-cols-7`）。
- 他の 6 状態と同じく `/tickets?status=Closed` へのクリック遷移も自動的に有効になる（既存の
  `Link href` はカードの `status` フィールドから汎用的に組み立てられているため）。
- Lite モードのダッシュボード (`LiteDashboard`) はそもそも「未対応」「期限切れ」の 2 タイルのみで
  7 状態のブレークダウンを持たない設計（§3.1）のため対象外。

#### 4.7 フォローアップ（2026-07-14 #2）: テナント作成（初代 admin 権限の付与）が監査ログの対象から漏れていた

監査で発見したギャップ: §4.5 で `SettingsAuditLog` の対象に招待リンク発行（`invitation_issue`）を
追加した際、その根拠は「新しい人物に社内の全チケットへのアクセス権を付与する操作」だったが、
テナント作成（`src/lib/tenant-provisioning.ts` の `provisionTenantWithAdmin`）は招待より強い
`admin` 権限そのものを新規発行する操作でありながら、運用者による作成（`create-tenant.ts`）・
セルフサーブサインアップ（`complete-signup.ts`、§7.1「30 分で運用開始」）のどちらの経路でも
監査対象から漏れたままだった。`/audit` では「誰がこのエージェントを招待したか」は追えても
「誰がこの admin アカウント（テナント自体）を作ったか」は一切追えなかった。

- `SettingsAuditAction`（`prisma/schema.prisma` / `src/domain/types.ts`）に `tenant_create` を
  追加し（マイグレーション `20260714000000_add_settings_audit_tenant_create`）、
  `src/lib/constants.ts` の `SETTINGS_AUDIT_ACTION_LABELS` に日本語ラベルを追加した。
- `create-tenant.ts`（運用者による作成）はテナント作成トランザクション成功後に
  `recordSettingsAudit({ actorId: session.user.id, action: 'tenant_create', ... })` を呼ぶ
  （§4.2 以降と同じ「操作成功後・記録失敗は本来の処理に影響させない」方針）。
- `complete-signup.ts`（セルフサーブサインアップ）は公開アクションでセッションが存在しない
  （サインアップトークン自体が認可の根拠）ため、`actorId` には「操作を行った人物 = 今まさに
  作成された初代管理者自身」の ID を使う。Stripe Webhook 起因の `actorId: null`（§4.4「システム
  による自動変更」）とは異なり、実在する人物が自分の意思で行った操作であるため区別した。
  トランザクション内で作成した `tenantId`/`adminId` は `uow.run` の戻り値に含めてトランザクション
  外へ持ち出し、外側の `let` 変数をクロージャ内で再代入する実装は避けた（TypeScript の制御フロー
  解析がクロージャ内の代入を追えず、参照時に意図せず `never` へ narrow されてしまうため）。
- `tests/features/create-tenant.test.ts` / `tests/features/complete-signup.test.ts` に、作成
  成功時に監査ログへ 1 件記録されること（`complete-signup` 側は `actorId` が新規作成された
  admin 自身の ID になること）の回帰テストを追加した。

#### 4.8 フォローアップ（2026-07-14 #4）: メール/LINE 取り込みチケットはカテゴリ・拠点を事後設定する手段が無く永久に未分類のままだった

監査で発見したギャップ: `CreateTicketInput`（`src/data/ports/ticket-repository.ts`）は
`categoryId`/`locationId` を起票時にしか受け取れず、起票後にこれらを変更する Server Action /
UI が一切存在しなかった（`updateTicketAssignee`/`updateTicketStatus`/`updateTicketPriority`/
`escalateTicket` の 4 種類しか事後変更手段がなかった）。Web フォーム（`POST /api/tickets`）と
CSV インポート（`import-tickets.ts`）は起票時にカテゴリ・拠点を指定できるが、メール取り込み
（`POST /api/inbound/email`）と LINE 取り込み（`POST /api/inbound/line`）は常に
`categoryId: null`・拠点未指定で起票する。LINE 取り込みのコード内コメントには「カテゴリは
未分類 (担当者が後で設定)」と明記されていたが、その「後で設定」する手段自体が存在しなかった。
Phase 2 の差別化の本丸であるメール/LINE 取り込みチャネルを主な入口とするテナントほど、この
影響を受けるチケットの割合が高くなり、§4.1/§4.1.1 で実装した拠点別ダッシュボード集計・
フィルタが、それらのチケットに対しては実質的に機能しない（永久に「全拠点合算」の一部として
しか集計されない）という体験だった。

- `prisma/schema.prisma` の `HistoryField` enum に `category`/`location` を追加し
  （マイグレーション `20260714010000_add_history_field_category_location`）、`src/domain/types.ts`
  / `src/lib/constants.ts` の `HISTORY_FIELD_LABELS` を同期した。`formatHistoryValue`
  （`src/lib/constants.ts`）は非対応フィールドをそのまま文字列表示するフォールバックを既に
  持っていたため変更不要だった。
- `TicketRepository` に `updateCategory`/`updateLocation`（tenantId スコープ、null で解除）を
  追加し、Prisma・メモリ両 Adapter に実装した（`updateAssignee` と同じ形）。
- `src/features/tickets/actions/update-ticket.ts` に `updateTicketCategory`/
  `updateTicketLocation` を追加した。RBAC・レート制限・存在確認・cross-tenant 遮断・履歴記録は
  いずれも `updateTicketAssignee` と同じパターンを踏襲する。カテゴリは Pro モード専用の概念
  （`TicketForm.tsx` の `{!isLite && (...)}` / `POST /api/tickets` の
  `effectiveCategoryId = mode === 'lite' ? null : ...` と同じ扱い）のため、Lite テナントでは
  指定値に関わらず静かに `null` へフォールバックする（CSV インポートの同種の分岐と同じ方針。
  UI 側でも Lite では選択欄自体を表示しないが、Server Action の直接呼び出しにも備えてサーバー側
  で強制する）。拠点はカテゴリと異なり Lite/Pro 両モードで使える概念（`TicketForm.tsx` の
  拠点欄は `locations.length > 0` のみで出し分けており mode によるガードが無い）のため、
  mode 判定は行わない。通知（メール/Slack/LINE 等）は追加しない — 担当者アサインと異なり
  カテゴリ・拠点変更に自然な「宛先」が無く、既存の 4 フィールドのうち通知を持たないのは
  ステータス/優先度変更の一部と同程度の低シグナル操作であるため、最小実装に留めた。
- `src/features/tickets/components/CategorySelect.tsx`/`LocationSelect.tsx`
  （`AssigneeSelect.tsx` と同じ設計のプルダウン）を追加し、`tickets/[id]/page.tsx` に配線した。
  カテゴリはエージェントかつ Pro モードのときのみ、拠点はエージェントかつ拠点が 1 件以上
  登録済みのときのみ編集可能なプルダウンを表示し、それ以外は従来どおり静的テキストのまま
  （`TicketForm.tsx` の起票時の出し分け条件と揃えた）。
- `tests/features/update-ticket.test.ts` に `updateTicketAssignee` と同じ構成（正常系・履歴
  記録・存在しない ID の拒否・cross-tenant 拒否）の回帰テストを追加し、カテゴリは Lite モードで
  静かに null へフォールバックすること、拠点は Lite モードでも通常どおり設定できることを
  追加で検証した。
- `/code-review ultra` 指摘対応: `updateTicketCategory`/`updateTicketLocation` が「チケット取得 →
  候補取得 → 存在確認」という同型の処理を個別に複製していた（2 箇所目の重複）ため、
  `loadTicketAndRef`（`update-ticket.ts`）として共通化した。あわせて `AssigneeSelect`/
  `CategorySelect`/`LocationSelect` が同型のプルダウン表示ロジックを 3 箇所複製していたため、
  `EntitySelect`（`src/features/tickets/components/EntitySelect.tsx`）へ抽出し、既存の
  `AssigneeSelect` も含めて共有するよう改修した（挙動・見た目は変更していない）。
  なお、これら 5 種のプルダウン（状態/優先度/担当者/カテゴリ/拠点）はいずれも `<label>` との
  プログラム的な関連付けを持たない a11y 上のギャップが `StatusSelect`/`PrioritySelect`
  （本 PR の対象外）から既に存在しており、本 PR の新規 2 種だけを個別に直すと同一画面内で
  対応状況が不揃いになるため、別途 5 種まとめて対応するフォローアップ課題として残す
  （§7 accessibility の `<label>`/`aria-labelledby` 要件）。

#### 4.9 フォローアップ（2026-07-16）: 担当者・カテゴリ・拠点プルダウンの未処理エラー

コードベース監査（既存フォローアップ群と同じ「済マーク済みの機能を実装から再点検する」観点）で
発見したギャップの修正。§1.4/§1.5 で `FaqStatusButton`/`StatusSelect`/`PrioritySelect` に
導入した「送信中は無効化し、失敗はその場にエラー表示、競合時は `router.refresh()` で最新化する」
契約が、§4.8 で追加した `EntitySelect`（`AssigneeSelect`/`CategorySelect`/`LocationSelect` が
共有する汎用プルダウン。`src/features/tickets/components/EntitySelect.tsx`）には一度も
適用されていなかった。

- **問題**: `EntitySelect` は `startTransition(() => onChange(val || null))` という形で、
  非同期の `onChange`（実体は `updateTicketAssignee`/`updateTicketCategory`/
  `updateTicketLocation`）が返す `Promise` を誰も `await` も `catch` もしていなかった。
  これらのサーバーアクションはレート制限超過・チケット消失（削除との競合）・指定先の不在
  （他エージェントによる担当者/カテゴリ/拠点の削除・退職処理との競合）で `Error` を throw する
  正常な失敗系路を持つが、`EntitySelect` 側で拒否 (`reject`) が誰にも処理されないため未処理の
  Promise 拒否になり、ユーザーには何も表示されないまま操作が黙って失敗していた
  （§6 エラーを握り潰さない、に反する）。`StatusSelect`/`PrioritySelect`（§1.5）・
  `FaqStatusButton`（§1.4）は同種の問題を既に解消済みだったが、`EntitySelect` は §4.8 で
  それらより後に追加されたにもかかわらず、この契約を踏襲していなかった。
- **修正**: `EntitySelect` に `useState` によるエラー表示と `useRouter().refresh()` を追加し、
  `handleChange` を `StatusSelect`/`FaqStatusButton` と同じ
  `startTransition(async () => { try { await onChange(...) } catch (err) { ... } })` の形に
  変更した。失敗時は `role="alert"` のメッセージをその場に表示し、`router.refresh()` で
  サーバーの最新状態を取り直す（エラー時は `revalidatePath` に到達しないため、担当者/カテゴリ/
  拠点の表示が古いまま残り続けるのを防ぐ）。`onChange` の型を `void` から `void | Promise<void>`
  に修正し、非同期であることを型シグネチャにも明示した。`AssigneeSelect`/`CategorySelect`/
  `LocationSelect` 側の変更は不要（`EntitySelect` への配線はそのまま）。
- 本修正は UI イベントハンドラのみの変更であり、`updateTicketAssignee`/`updateTicketCategory`/
  `updateTicketLocation`（サーバー側の検証・RBAC・tenantId スコープ）自体には変更がない。
  リポジトリに React コンポーネント向けのユニットテスト基盤（jsdom / Testing Library 等）が
  無く、Vitest は `environment: 'node'` で `tests/**/*.test.ts` のみを対象とする構成のため
  （`vitest.config.ts`）、`FaqStatusButton`/`StatusSelect`/`PrioritySelect` の同種の修正
  （§1.4/§1.5）と同じく、この UI 層の変更にも専用のコンポーネント単体テストは追加していない。

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

#### 5.4.1 フォローアップ（2026-07-10）: LINE 通知がコメント返信にしか実装されていなかった

監査で発見したギャップ: `notify:line` は「担当者の返信が LINE に返る」（Phase 2）としてコメント
返信（`POST /api/tickets/[id]/comments`）にのみ実装されており、`notify:email` と並ぶ通知チャネル
として §5.4 が意図した「主要イベントを 0〜複数チャネルへ届ける」という設計にはなっていなかった。
実際には、依頼者が LINE 連携済みでも、ステータス変更（「対応中になりました」「解決しました」）は
メールでしか届かず、依頼者はアプリを開くかメールを見るまで気づけなかった。ステータス変更は
コメント返信と並ぶ最も重要な進捗通知であり、このギャップは §2 のギャップ分析表「通知」行
（メール通知 & LINE 通知を通知の主軸にする）の意図に反していた。

- `src/lib/line-push.ts` に `buildTicketStatusChangedLineMessage`（純粋関数）を追加し、
  既存の `buildTicketReplyLineMessage` と同じ「本文組み立て（純粋関数）/ 送る（副作用）」の
  分離方針を踏襲した。
- `src/features/tickets/actions/update-ticket.ts` の `updateTicketStatus` に
  `sendStatusChangedLineToRequester` を追加し、`sendStatusChangedEmailToRequester` と同じ条件
  （自分以外の起票者向け）で LINE push も送るようにした。判定順序
  （依頼者の LINE 連携 → テナントの `TenantLineConfig` → プランゲート `isLineIntegrationAllowed`）
  は `comments/route.ts` の `sendReplyLineToRequester` と揃えた。
- 優先度変更・担当者アサインへの LINE 通知拡張は本フォローアップのスコープ外として残す
  (メールと並ぶ最重要イベントであるステータス変更を優先し、変更を 1 コミット 1 論理変更に保つ)。
- `/code-review ultra` 指摘対応: 当初の実装は「テナントの `TenantLineConfig` を引く →
  プランゲートを確認する」という判定ロジックを `comments/route.ts` の `sendReplyLineToRequester`
  からそのまま書き写した重複実装だった（§6 DRY: 2 箇所目の複製が生じた時点で共通化する方針に
  反する）。`resolveLineAccessToken`（`src/lib/line-push.ts`）へ抽出し、両呼び出し元がこれを
  共有するよう統合した。あわせて `resolveLineAccessToken` はリクエストスコープでメモ化された
  `getCachedTenant`（`src/lib/tenant-cache.ts`）経由でテナントを取得するため、
  `updateTicketStatus` が既に `getCurrentTenantMode` で読み込み済みの `Tenant` 行への冗長な
  `SELECT` も同時に解消した。また、メール送信ヘルパーと LINE 送信ヘルパーが個別に
  `repos.users.findById(creatorId)` していた重複呼び出しも、`comments/route.ts` の
  `notifyRequesterOfReply` と同じ「依頼者情報を 1 度だけ引き、独立した I/O である各チャネルへ
  `Promise.all` で並行送信する」設計に揃えて解消した（従来は 2 チャネル分の送信が直列に
  積み上がっていた）。

#### 5.4.2 フォローアップ（2026-07-10）: 優先度変更が LINE 通知の対象外のままだった

監査で発見したギャップ: §5.4.1 は「優先度変更・担当者アサインへの LINE 通知拡張は本フォローアップの
スコープ外として残す」と明記してステータス変更のみに対応していた。しかし優先度変更もステータス変更と
並ぶ依頼者向けの主要イベントであり（`updateTicketPriority` は起票者への app 内通知・メール通知を
発行する）、§2 のギャップ分析表「通知」行（メール通知 & LINE 通知を通知の主軸にする）の意図に対して、
LINE 連携済みの依頼者だけが優先度変更に気づけないというギャップが残っていた。
なお担当者アサインの通知先は依頼者ではなく社内エージェント（常にアプリにログインしている前提）
であるため、依頼者向け通知チャネルである LINE 連携の対象には含めず、今回は優先度変更のみを対応した。

- `src/lib/line-push.ts` に `buildTicketPriorityChangedLineMessage`（純粋関数）を追加し、
  `buildTicketStatusChangedLineMessage` と同じ文面構成にした。
- `src/features/tickets/actions/update-ticket.ts` の `updateTicketPriority` に、
  §5.4.1 の `notifyRequesterOfStatusChange` と同じ「依頼者情報を 1 度だけ引き、メール/LINE を
  `Promise.all` で並行送信する」設計 (`notifyRequesterOfPriorityChange`) を追加した。判定順序
  （依頼者の LINE 連携 → テナントの `TenantLineConfig` → プランゲート）・失敗時の握り潰し方針は
  ステータス変更と揃えている。

### 5.5 認証

- Auth.js v5 に **Email Provider（マジックリンク）** を追加。実装済み（`src/lib/magic-link.ts` 等。
  15 分 TTL・原子的な単回消費・実 SMTP 送信＋開発時 console フォールバック）。
- ~~既存 Credentials Provider は Pro モードのみ表示（既定で隠す）~~ → **設計を修正（2026-07-03）**:
  `/login` は全テナント共通の未認証ページであり、ユーザーがメールアドレスを入力する前は
  どのテナント（つまり `mode`）に属するかをサーバー側で解決できない。そのため「Lite なら既定で
  Credentials タブを隠す」を文字どおり実装するには、(a) メール入力を経てテナントを特定してから
  タブを出し分ける事前ステップを新設するか、(b) `?tenant=` 等でテナントを特定できるログイン URL
  を招待/オンボーディング導線ごとに新設する、のいずれかが必要になる。一方で既存 E2E スイート
  （`e2e/tickets.spec.ts` / `lite-mode.spec.ts` / `rbac.spec.ts` / `multitenant.spec.ts` /
  `tenant-create.spec.ts` など）は軒並み `mode: 'lite'` の既定シードテナントに対してパスワード
  タブ経由でログインしており、この動作は `LoginTabs.tsx` のコメントにも「E2E 互換性のため、
  メール優先にしない」と明記されている意図的な選択。上記のいずれの対応も E2E スイートの広範な
  作り直しを要し、1 行の要件のために不釣り合いなリスクを取ることになるため、本計画では
  **両方のログイン経路を全テナント常時表示のままとし、マジックリンクを推奨・既定タブとして
  案内する（UI 上での誘導のみ）** 方針に変更する。将来 Credentials を Lite で完全に隠したい場合は、
  既存の per-tenant SSO ルート（`/api/auth/sso/[tenantId]/*`）と同様に **テナントスコープ付き
  ログイン URL** を新設し、招待メール・オンボーディング導線をそちら経由に切り替えたうえで、
  E2E フィクスチャに Pro 用テナントを追加してから着手する。
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

#### 7.1.1 フォローアップ（2026-07-10）: メンバー招待の「CSV」経路が存在しなかった

監査で発見したギャップ: 上記手順3は「メンバーを招待（**リンク貼り付け or CSV**）」と明記して
いたが、実装 (`createInvitation` / `InviteForm.tsx`) は 1 回の呼び出しにつき 1 件の招待リンクしか
発行できず、CSV による一括招待の経路が存在しなかった。§1.1 のペルソナ「町工場の事務員 田中さん」
（従業員 30 名）がこの手順どおりに運用開始しようとすると、招待リンクを最大 30 回、
1 件ずつ発行してコピー＆共有する必要があり、「30 分で運用開始」の前提を崩していた。

- `src/features/settings/actions/create-invitation.ts` から「シート上限確認 → トークン発行 →
  DB 保存 → 案内メール送信」の内部ロジックを `issueInvitation` として切り出し、新設した
  `src/features/settings/actions/create-invitations-bulk.ts`（`createInvitationsBulk`）と
  共有する（§6 DRY）。
- 複数行テキスト（1 行 1 メール、または CSV の 1 列目）からメールアドレス候補を抽出する純粋関数
  `extractEmailCandidates` を `src/lib/invite.ts` に追加。ticket import と同じ `parseCsvLine`
  （`src/lib/csv.ts`）を再利用し、ヘッダ行の除外・大文字小文字を無視した重複除去を行う。
  `MAX_BULK_INVITE_ROWS`（= `INVITE_RATE_LIMIT_MAX` と同値の 30 件）で 1 回のバッチ件数を制限する。
- `src/features/settings/components/InviteForm.tsx` を「個別に招待」「まとめて招待（CSV）」の
  タブ切替に変更し、新設の `BulkInviteForm.tsx` が CSV ファイル選択（`File.text()` で読み込み）
  または直接貼り付けの両方を受け付ける。行ごとの発行結果（成功/失敗）を一覧表示し、
  シート上限などで一部の行だけ失敗しても他の行の発行は止めない（部分成功を許容する）。
- テナント単位のレート制限（1 時間 30 件）はバッチ全体で 1 回だけ確認し、バッチ発行後に上限を
  超える場合は 1 件も発行せずに拒否する（一部だけ発行されて admin が「どこまで届いたか」を
  判別しづらくなる事態を避けるため）。

#### 7.1.2 フォローアップ（2026-07-10）: メール転送の案内が Free プランでは行き止まりだった

監査で発見したギャップ: 上記手順4は Standard 以上（Free trial 中も含む）のテナントにのみ表示される
`emailInboundAllowed` ゲート（`settings/page.tsx`）付きの機能だが、`/dashboard` の「はじめかた」
チュートリアルセクション（`GETTING_STARTED_STEPS`）はこのゲートを一切考慮せず、`isAgent` かつ
チケット件数が閾値未満のテナントであれば常に「メールの転送アドレスを設定する」ステップを表示して
いた。§6.1 の料金表は「Free: メール取り込み不可」と明記しており、Free プラン（トライアル終了後）の
admin がこのステップに従って `/settings` を開いても、対応する転送先アドレスのカードは存在しない
（表示条件を満たさない）。案内どおりに操作しても目的を達成できない行き止まりのオンボーディングだった。

- `src/lib/getting-started-steps.ts` を新設し、「はじめかた」ステップの定義と組み立てロジック
  (`buildGettingStartedSteps(emailInboundAllowed)`) を dashboard/page.tsx から切り出した
  （テスト容易性のため純粋関数として分離。`tutorial-video.ts` と同じ設計方針）。
  `settings/page.tsx` と同じ `resolveTenantPlan` + `isEmailInboundAllowed` の判定で、メール転送
  ステップを含めるかどうかを出し分ける。
- メール転送ステップを省いた場合、残りのステップ番号を 1, 2 と詰めて振り直す（1, 3 のような
  歯抜けの番号を画面に出さないため）。

### 7.2 「失敗しない撤退ポイント」

- 30 日間の Free trial（Standard 相当）。延長は問い合わせベース。
- **CSV エクスポート**を全プランで保証（ロックインしない安心感）。

#### 7.2.1 フォローアップ（2026-07-09）: トライアル終了リマインダー

初回実装ではトライアル残日数の計算・表示（`trialDaysRemaining`）を `/settings` 画面にのみ持ち、
管理者が自ら設定画面を開かない限り終了が近いことに気づけなかった（監査で発見したギャップ）。
これは §7.2 の「失敗しない撤退ポイント」の意図（気づかないまま不利益を被らせない）に反するため、
以下を追加実装する:

- 純粋ロジック・メール本文組み立ては `src/lib/trial-reminder.ts`（残り 5 日・1 日でリマインド）。
- 送信先は `TenantRepository.listActiveTrials` で対象テナントを取得し、
  `UserRepository.listAdminEmails`（admin 限定。課金操作が admin 限定なのと同じ理由）へ送る。
- `POST /api/internal/trial-reminders` を共有シークレット (`TRIAL_REMINDER_CRON_SECRET`) 認証の
  内部エンドポイントとして実装し、`.github/workflows/trial-reminders.yml` が毎日 1 回叩く
  （`scripts/backup-db.sh` + `backup.yml` と同じ「daily cron」設計をベースにする）。
- `/code-review ultra` 指摘対応: 当初「残り日数がちょうど 5 日 / 1 日の日だけ送る」設計だったが、
  GitHub Actions の cron は手動再実行 (`workflow_dispatch`)・遅延・欠落がありうる best-effort な
  実行であるため、ちょうどの日を通り過ぎて取りこぼしたり、手動再実行で同日に二重送信したりする
  恐れがあった。`Tenant.trialReminderLastSentDaysBefore` に直近送信済みのマイルストーンを永続化し、
  「まだ送っていない最も緊急なマイルストーンに達していれば送る」方式 (`resolveTrialReminderMilestone`)
  に変更することで、cron が何度・いつ叩かれても二重送信・取りこぼしの両方を防ぐ。

---

## 8. リスクと対策

| リスク | 影響 | 対策 |
| --- | --- | --- |
| 既存ユーザー（情シス向け）と SMB 向けで UI が衝突 | Pro ユーザーの混乱 | `mode` フラグでテナント単位に切替。UI コンポーネントを mode-aware に集約 |
| マルチテナント化のデータ漏えい | 致命的 | Port 層に `tenantId` 強制を契約として埋め込み、回帰テストを必須化 |
| メール取り込みの SPF/DKIM 偽装 | スパム混入・なりすまし | **実装済み**: 送信元ドメイン検証（プロバイダ算出の SPF/DKIM/DMARC 結果を消費し、`INBOUND_EMAIL_AUTH=enforce` で明示 fail を隔離）＋ 既知メンバーのみ起票許可（不明送信者は隔離 202）。既定は off で段階導入 |
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
