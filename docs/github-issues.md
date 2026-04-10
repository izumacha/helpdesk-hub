# GitHub Issues 登録用ドラフト（36件）

> このリポジトリには `remote.origin.url` が未設定で、`gh` CLI も未導入のため、この環境から直接 GitHub Issue の作成は実行できません。
> 本ファイルをそのまま GitHub に転記して Issue 登録してください。

---

## 1. feat: initialize Next.js project with Tailwind and ESLint

### 概要
問い合わせ管理システムのフロントエンド基盤として、Next.js + TypeScript + Tailwind CSS の初期構成を作成する。

### 目的
今後の画面開発、スタイル適用、コード品質管理を安定して進められる土台を整える。

### タスク
- [ ] Next.js プロジェクトを作成する
- [ ] TypeScript 設定を確認する
- [ ] Tailwind CSS を導入する
- [ ] ESLint を有効化する
- [ ] Prettier を導入する
- [ ] `src/` ベースのディレクトリ構成を作成する
- [ ] `components` `features` `lib` `types` `hooks` `server` ディレクトリを作成する
- [ ] 開発サーバー起動を確認する

### 完了条件
- `npm run dev` でアプリが起動する
- Tailwind のスタイルが適用される
- Lint と Format が実行できる
- ベースのディレクトリ構成が作成されている

### 依存Issue
- なし

---

## 2. feat: set up Prisma with PostgreSQL

### 概要
Prisma と PostgreSQL を接続し、アプリケーションからDBを利用できる状態を作る。

### 目的
問い合わせ、ユーザー、履歴などの業務データを永続化できる基盤を整える。

### タスク
- [ ] Prisma を導入する
- [ ] PostgreSQL 接続情報を `.env` に設定する
- [ ] `prisma/schema.prisma` を作成する
- [ ] Prisma Client を生成する
- [ ] 初期接続確認を行う
- [ ] `.env.example` を作成する
- [ ] README にDB設定の下書きを追記する

### 完了条件
- Prisma から PostgreSQL に接続できる
- `npx prisma generate` が成功する
- `.env.example` が用意されている
- ローカルDB接続手順の最低限が共有できる

### 依存Issue
- #1 feat: initialize Next.js project with Tailwind and ESLint

---

## 3. feat: create shared application layout and navigation

### 概要
ログイン後に利用する共通レイアウトとナビゲーションを実装する。

### 目的
画面間の導線を統一し、問い合わせ一覧、登録、ダッシュボードなどを追加しやすい構造にする。

### タスク
- [ ] 共通レイアウトコンポーネントを作成する
- [ ] ヘッダーを作成する
- [ ] サイドバーを作成する
- [ ] ナビゲーションリンクを配置する
- [ ] モバイルでも最低限崩れないレイアウトにする
- [ ] ページタイトル表示領域を用意する
- [ ] 仮ページへの遷移を確認する

### 完了条件
- 共通レイアウトが適用される
- 一覧、登録、ダッシュボードに遷移できる導線がある
- 各ページで見た目が統一されている

### 依存Issue
- #1 feat: initialize Next.js project with Tailwind and ESLint

---

## 4. feat: implement authentication with role support

### 概要
ログイン、ログアウト、および保護ページへのアクセス制御を実装する。

### 目的
問い合わせ情報をユーザー単位で安全に扱い、今後のロール制御の基盤を用意する。

### タスク
- [ ] Auth.js を導入する
- [ ] Credentials 認証を設定する
- [ ] ログイン画面を作成する
- [ ] ログアウト機能を実装する
- [ ] 保護ページで未ログイン時のリダイレクト処理を追加する
- [ ] セッションからユーザー情報を取得できるようにする
- [ ] ロール情報をセッションに含められる設計にする

### 完了条件
- ログインとログアウトができる
- 未ログインで保護ページへアクセスできない
- セッションからユーザーIDとロールを参照できる

### 依存Issue
- #1 feat: initialize Next.js project with Tailwind and ESLint
- #2 feat: set up Prisma with PostgreSQL

---

## 5. feat: design user model and role seed data

### 概要
ユーザーとロールのDBモデルを作成し、初期データを投入できるようにする。

### 目的
requester、agent、admin など役割ごとの挙動を実装する前提を整える。

### タスク
- [ ] User モデルを定義する
- [ ] role フィールドを追加する
- [ ] requester / agent / admin のロールを定義する
- [ ] seed スクリプトを作成する
- [ ] テスト用ユーザーを複数作成する
- [ ] Auth.js と整合する項目を確認する

### 完了条件
- DBに複数ロールのユーザーを投入できる
- セッション連携に使えるユーザー情報が揃っている
- seed 実行で初期ユーザーが登録される

### 依存Issue
- #2 feat: set up Prisma with PostgreSQL
- #4 feat: implement authentication with role support

---

## 6. feat: create initial Prisma schema for ticket management

### 概要
問い合わせ管理に必要な主要テーブルを Prisma スキーマに定義する。

### 目的
問い合わせ、コメント、履歴、カテゴリなどのデータ構造を明確にし、機能実装を進めやすくする。

### タスク
- [ ] `Ticket` モデルを作成する
- [ ] `TicketComment` モデルを作成する
- [ ] `TicketHistory` モデルを作成する
- [ ] `Category` モデルを作成する
- [ ] User とのリレーションを定義する
- [ ] ステータス、優先度の項目を定義する
- [ ] 初回マイグレーションを作成する
- [ ] Prisma Client を再生成する

### 完了条件
- 主要モデルがスキーマに定義されている
- マイグレーションが適用できる
- リレーションエラーなく Prisma Client を生成できる

### 依存Issue
- #2 feat: set up Prisma with PostgreSQL
- #5 feat: design user model and role seed data

---

## 7. feat: create ticket list page

### 概要
問い合わせ一覧画面を実装し、登録済みの問い合わせを確認できるようにする。

### 目的
担当者が未対応、対応中、解決済みの問い合わせを俯瞰できる状態を作る。

### タスク
- [ ] `/tickets` ページを作成する
- [ ] 一覧表示用のテーブルコンポーネントを作成する
- [ ] 問い合わせ一覧取得処理を実装する
- [ ] 件名、ステータス、優先度、担当者、作成日を表示する
- [ ] 詳細画面へのリンクを追加する
- [ ] ローディング表示を追加する
- [ ] データが0件のときの表示を追加する

### 完了条件
- DBから取得した問い合わせ一覧が表示される
- 必要な主要項目が確認できる
- 各行から詳細画面へ遷移できる

### 依存Issue
- #3 feat: create shared application layout and navigation
- #4 feat: implement authentication with role support
- #6 feat: create initial Prisma schema for ticket management

---

## 8. feat: create ticket detail page

### 概要
個別問い合わせの詳細画面を実装する。

### 目的
問い合わせ内容、状態、担当者、コメント、履歴などを1画面で確認できるようにする。

### タスク
- [ ] `/tickets/[id]` ページを作成する
- [ ] 問い合わせ詳細取得処理を実装する
- [ ] 件名、本文、カテゴリ、優先度、ステータス、担当者を表示する
- [ ] コメント表示領域を作成する
- [ ] 履歴表示用の領域を用意する
- [ ] データ取得失敗時の表示を追加する

### 完了条件
- 一覧から詳細画面へ遷移できる
- 個別問い合わせの主要情報が表示される
- コメントと履歴を追加できる下地がある

### 依存Issue
- #6 feat: create initial Prisma schema for ticket management
- #7 feat: create ticket list page

---

## 9. feat: implement ticket creation API

### 概要
問い合わせを登録するための API を実装する。

### 目的
フォームから送信された問い合わせ情報をDBへ保存できるようにする。

### タスク
- [ ] 問い合わせ登録用の API エンドポイントを作成する
- [ ] タイトル、内容、カテゴリ、優先度を受け取る
- [ ] Zod で入力バリデーションを実装する
- [ ] 作成者情報を保存する
- [ ] 例外処理とエラーレスポンスを実装する
- [ ] 正常系レスポンス形式を決める

### 完了条件
- 正常入力で問い合わせが作成される
- 不正入力でエラーが返る
- 作成者付きで問い合わせが保存される

### 依存Issue
- #4 feat: implement authentication with role support
- #6 feat: create initial Prisma schema for ticket management

---

## 10. feat: implement ticket creation form

### 概要
問い合わせ登録画面を作成し、画面から問い合わせを登録できるようにする。

### 目的
依頼者または担当者が問い合わせを簡単にシステムへ登録できるようにする。

### タスク
- [ ] `/tickets/new` ページを作成する
- [ ] React Hook Form を導入する
- [ ] タイトル入力欄を作成する
- [ ] 内容入力欄を作成する
- [ ] カテゴリ選択欄を作成する
- [ ] 優先度選択欄を作成する
- [ ] Zod バリデーションを組み込む
- [ ] 登録APIと接続する
- [ ] 登録成功時の遷移を実装する
- [ ] エラーメッセージを表示する

### 完了条件
- フォームから問い合わせを登録できる
- 必須項目未入力時にエラーが表示される
- 登録後に一覧または詳細へ遷移できる

### 依存Issue
- #3 feat: create shared application layout and navigation
- #9 feat: implement ticket creation API

---

## 11. feat: implement initial category management

### 概要
問い合わせ分類のためのカテゴリ管理を初期実装する。

### 目的
問い合わせを用途別に分類し、一覧や分析で扱いやすくする。

### タスク
- [ ] Category の seed データを作成する
- [ ] 代表カテゴリを決める
- [ ] 登録フォームでカテゴリ選択可能にする
- [ ] 一覧画面にカテゴリを表示する
- [ ] 詳細画面にカテゴリを表示する
- [ ] カテゴリ未設定時の扱いを決める

### 完了条件
- 問い合わせにカテゴリが紐づく
- 登録、一覧、詳細の各画面でカテゴリを確認できる
- 初期カテゴリが seed で投入される

### 依存Issue
- #6 feat: create initial Prisma schema for ticket management
- #10 feat: implement ticket creation form

---

## 12. feat: add ticket status update feature

### 概要
問い合わせのステータスを更新できる機能を実装する。

### 目的
New、Open、In Progress、Resolved、Closed などの進捗を管理できるようにする。

### タスク
- [ ] ステータス更新APIを作成する
- [ ] 詳細画面にステータス変更UIを追加する
- [ ] 更新可能なステータス候補を定義する
- [ ] 更新成功時に画面へ反映する
- [ ] エラー時の表示を追加する

### 完了条件
- 詳細画面からステータスを変更できる
- 更新内容がDBへ保存される
- 更新後に画面表示が反映される

### 依存Issue
- #8 feat: create ticket detail page
- #6 feat: create initial Prisma schema for ticket management

---

## 13. feat: add ticket priority update feature

### 概要
問い合わせの優先度を更新できる機能を実装する。

### 目的
重要度に応じて問い合わせ対応の優先順位を付けられるようにする。

### タスク
- [ ] priority フィールドの扱いを整理する
- [ ] 優先度更新APIを作成する
- [ ] 詳細画面に優先度変更UIを追加する
- [ ] 一覧画面に優先度表示を反映する
- [ ] 更新失敗時の表示を追加する

### 完了条件
- Low、Medium、High の優先度を変更できる
- 一覧と詳細の表示が更新される
- 優先度変更がDBへ保存される

### 依存Issue
- #8 feat: create ticket detail page
- #6 feat: create initial Prisma schema for ticket management

---

## 14. feat: add ticket assignee assignment feature

### 概要
問い合わせに担当者を割り当てる機能を実装する。

### 目的
誰が対応する案件かを明確化し、対応漏れを防ぐ。

### タスク
- [ ] 担当者一覧取得処理を実装する
- [ ] `assignee_id` 更新APIを作成する
- [ ] 詳細画面に担当者選択UIを追加する
- [ ] 一覧画面に担当者名を表示する
- [ ] 未割当時の表示を定義する

### 完了条件
- 問い合わせに担当者を設定できる
- 一覧と詳細に担当者が表示される
- 担当者変更がDBへ保存される

### 依存Issue
- #5 feat: design user model and role seed data
- #8 feat: create ticket detail page

---

## 15. feat: add ticket comment feature

### 概要
問い合わせに対して対応コメントを投稿できる機能を実装する。

### 目的
やり取りや対応メモを時系列で残し、経緯を追えるようにする。

### タスク
- [ ] コメント投稿APIを作成する
- [ ] 詳細画面にコメント入力欄を追加する
- [ ] コメント一覧表示を実装する
- [ ] 投稿者名と投稿日時を表示する
- [ ] 空文字投稿を防ぐバリデーションを追加する

### 完了条件
- コメントを投稿できる
- 投稿済みコメントが時系列で表示される
- 投稿者と日時が確認できる

### 依存Issue
- #8 feat: create ticket detail page
- #6 feat: create initial Prisma schema for ticket management
- #4 feat: implement authentication with role support

---

## 16. feat: record ticket history on updates

### 概要
問い合わせの変更履歴を記録する仕組みを実装する。

### 目的
ステータス変更、優先度変更、担当者変更などを追跡できるようにし、実務上の監査性を高める。

### タスク
- [ ] TicketHistory への保存処理を実装する
- [ ] ステータス変更時に履歴を保存する
- [ ] 優先度変更時に履歴を保存する
- [ ] 担当者変更時に履歴を保存する
- [ ] 変更者、変更前、変更後、変更日時を記録する
- [ ] 履歴種別を定義する

### 完了条件
- 主要更新操作ごとに履歴が保存される
- 誰がいつ何を変えたか記録される
- 履歴データが詳細画面表示に使える状態になっている

### 依存Issue
- #12 feat: add ticket status update feature
- #13 feat: add ticket priority update feature
- #14 feat: add ticket assignee assignment feature

---

## 17. feat: display ticket history on detail page

### 概要
問い合わせ詳細画面に変更履歴を表示する。

### 目的
問い合わせの対応経緯を画面上で確認できるようにする。

### タスク
- [ ] 履歴取得処理を実装する
- [ ] 詳細画面に履歴一覧UIを追加する
- [ ] 変更項目、変更前後、変更者、日時を表示する
- [ ] 表示順を新しい順または古い順で整理する
- [ ] 履歴0件時の表示を追加する

### 完了条件
- 詳細画面で履歴が確認できる
- ステータス、優先度、担当者変更の流れを追える
- 誰が更新したか分かる

### 依存Issue
- #8 feat: create ticket detail page
- #16 feat: record ticket history on updates

---

## 18. feat: implement ticket keyword search

### 概要
問い合わせ一覧画面でキーワード検索できる機能を実装する。

### 目的
件名や本文から目的の問い合わせを素早く探せるようにする。

### タスク
- [ ] 検索フォームを一覧画面に追加する
- [ ] クエリパラメータと連動させる
- [ ] 件名検索を実装する
- [ ] 本文検索を実装する
- [ ] 検索結果0件時の表示を追加する
- [ ] 検索条件の保持を確認する

### 完了条件
- 件名または本文を対象に検索できる
- URLクエリで検索条件を保持できる
- 検索結果が一覧へ反映される

### 依存Issue
- #7 feat: create ticket list page

---

## 19. feat: implement ticket filters on list page

### 概要
問い合わせ一覧画面で複数条件による絞り込み機能を実装する。

### 目的
ステータス、カテゴリ、優先度、担当者ごとに問い合わせを整理して確認できるようにする。

### タスク
- [ ] ステータス絞り込みUIを追加する
- [ ] カテゴリ絞り込みUIを追加する
- [ ] 優先度絞り込みUIを追加する
- [ ] 担当者絞り込みUIを追加する
- [ ] 複数条件の組み合わせ検索を実装する
- [ ] URLクエリに条件を反映する
- [ ] リセット機能を追加する

### 完了条件
- 複数条件で一覧を絞り込める
- 条件がURLに反映される
- 画面再読み込み後も条件が保持される

### 依存Issue
- #7 feat: create ticket list page
- #11 feat: implement initial category management
- #14 feat: add ticket assignee assignment feature

---

## 20. feat: add pagination to ticket list

### 概要
問い合わせ一覧画面にページネーションを実装する。

### 目的
問い合わせ件数が増えても一覧表示を扱いやすくする。

### タスク
- [ ] 一覧取得APIにページング条件を追加する
- [ ] 現在ページと総件数を扱えるようにする
- [ ] 一覧画面にページネーションUIを追加する
- [ ] 検索・絞り込み条件と併用できるようにする
- [ ] ページ移動時の表示崩れを確認する

### 完了条件
- 一覧画面でページ切り替えができる
- 検索、絞り込みと併用できる
- ページングに応じて表示件数が変わる

### 依存Issue
- #7 feat: create ticket list page
- #18 feat: implement ticket keyword search
- #19 feat: implement ticket filters on list page

---

## 21. feat: implement role-based access control

### 概要
ロール別の閲覧、操作制御を実装する。

### 目的
requester、agent、admin ごとに適切なデータアクセス範囲を定義し、安全に運用できるようにする。

### タスク
- [ ] requester の閲覧範囲を定義する
- [ ] agent の閲覧範囲を定義する
- [ ] admin の閲覧範囲を定義する
- [ ] 一覧取得APIでロールに応じた条件分岐を実装する
- [ ] 詳細取得APIで権限チェックを実装する
- [ ] UI上で操作可能項目をロール別に出し分ける
- [ ] 権限不足時の表示を追加する

### 完了条件
- ロールに応じて見られる問い合わせ範囲が変わる
- 権限のない更新操作が実行できない
- UI上でも不要な操作が表示されない

### 依存Issue
- #4 feat: implement authentication with role support
- #5 feat: design user model and role seed data
- #7 feat: create ticket list page
- #8 feat: create ticket detail page

---

## 22. feat: enforce valid ticket status transitions

### 概要
問い合わせのステータス遷移ルールを実装し、不正な更新を防ぐ。

### 目的
Closed から直接 In Progress に戻すなどの業務ルール違反を防止する。

### タスク
- [ ] 有効なステータス一覧を整理する
- [ ] 許可する遷移パターンを定義する
- [ ] ステータス遷移判定ロジックを関数化する
- [ ] API側で不正遷移を拒否する
- [ ] UI側で不正な選択肢を無効化する
- [ ] エラーメッセージを追加する

### 完了条件
- 許可されていないステータス遷移が弾かれる
- UIで無効な遷移候補が表示されない
- 遷移ルールがコード上で明文化されている

### 依存Issue
- #12 feat: add ticket status update feature

---

## 23. feat: add SLA fields to ticket model

### 概要
問い合わせに初回応答期限、解決期限などのSLA関連項目を追加する。

### 目的
問い合わせごとの対応期限を管理し、遅延を可視化できる土台を作る。

### タスク
- [ ] `first_response_due_at` を追加する
- [ ] `resolution_due_at` を追加する
- [ ] `first_responded_at` を追加する
- [ ] `resolved_at` を追加する
- [ ] Prisma スキーマを更新する
- [ ] マイグレーションを作成する
- [ ] 詳細画面表示に必要な取得項目を更新する

### 完了条件
- Ticket に SLA 項目が保存できる
- マイグレーションが適用されている
- 取得処理で SLA 情報を扱える

### 依存Issue
- #6 feat: create initial Prisma schema for ticket management

---

## 24. feat: implement SLA due state and overdue display

### 概要
問い合わせごとのSLA状態を判定し、期限間近や超過を画面上で表示する。

### 目的
優先的に対応すべき問い合わせを一目で判別できるようにする。

### タスク
- [ ] SLA状態判定ロジックを実装する
- [ ] 一覧画面で期限間近表示を追加する
- [ ] 一覧画面で期限超過表示を追加する
- [ ] 詳細画面に SLA 情報を表示する
- [ ] 表示文言と視覚表現を整理する
- [ ] 判定ロジックを再利用できる形に分離する

### 完了条件
- 各問い合わせの SLA 状態が判定される
- 一覧で期限間近と超過が分かる
- 詳細画面で期限情報が確認できる

### 依存Issue
- #7 feat: create ticket list page
- #8 feat: create ticket detail page
- #23 feat: add SLA fields to ticket model

---

## 25. feat: add escalation workflow

### 概要
問い合わせを一次受付から二次対応へエスカレーションできる機能を実装する。

### 目的
難易度の高い問い合わせや対応範囲外の案件を適切に引き継げるようにする。

### タスク
- [ ] `escalated_at` 項目を追加する
- [ ] `escalation_reason` 項目を追加する
- [ ] エスカレーション実行APIを作成する
- [ ] 詳細画面にエスカレーションUIを追加する
- [ ] 理由入力欄を追加する
- [ ] 履歴にもエスカレーション記録を残す
- [ ] エスカレーション後のステータス変更方針を整理する

### 完了条件
- 問い合わせをエスカレーションできる
- 理由と日時が保存される
- 履歴画面からエスカレーション実施が確認できる

### 依存Issue
- #8 feat: create ticket detail page
- #16 feat: record ticket history on updates
- #23 feat: add SLA fields to ticket model

---

## 26. feat: build dashboard page with key support metrics

### 概要
問い合わせ管理の主要指標を確認できるダッシュボード画面を実装する。

### 目的
未対応件数、対応中件数、SLA超過件数などを俯瞰し、全体状況を把握しやすくする。

### タスク
- [ ] `/dashboard` ページを作成する
- [ ] 未対応件数を表示する
- [ ] 対応中件数を表示する
- [ ] 解決済み件数を表示する
- [ ] SLA超過件数を表示する
- [ ] カードUIを作成する
- [ ] 一覧画面への導線を追加する

### 完了条件
- ダッシュボードで主要指標を確認できる
- 各指標から問い合わせ一覧へ移動しやすい
- 画面全体の状況把握に使える

### 依存Issue
- #3 feat: create shared application layout and navigation
- #7 feat: create ticket list page
- #24 feat: implement SLA due state and overdue display

---

## 27. feat: visualize workload by assignee

### 概要
担当者別の問い合わせ件数を可視化する。

### 目的
担当偏りを把握し、業務負荷の偏在を見つけやすくする。

### タスク
- [ ] 担当者別件数の集計処理を実装する
- [ ] ダッシュボードまたはレポート画面に表示する
- [ ] 未割当件数も表示対象に含める
- [ ] 表示順を件数順などで整理する
- [ ] 表示結果から一覧へ遷移できる導線を追加する

### 完了条件
- 担当者ごとの件数が確認できる
- 未割当も含めた負荷状況が把握できる
- 集計結果を一覧確認につなげられる

### 依存Issue
- #14 feat: add ticket assignee assignment feature
- #26 feat: build dashboard page with key support metrics

---

## 28. feat: add FAQ candidate conversion feature

### 概要
解決済み問い合わせをFAQ候補として登録できる機能を実装する。

### 目的
問い合わせ対応で得られた知見をFAQへ活用し、今後の問い合わせ削減につなげる。

### タスク
- [ ] FAQ候補用モデルを作成する
- [ ] 解決済み問い合わせから候補化するAPIを作成する
- [ ] 詳細画面にFAQ候補化ボタンを追加する
- [ ] FAQ候補一覧画面を作成する
- [ ] 候補ステータスを持てるようにする
- [ ] 元問い合わせとの紐付けを保持する

### 完了条件
- 解決済み問い合わせをFAQ候補に変換できる
- 候補一覧で確認できる
- 元問い合わせとの関連が分かる

### 依存Issue
- #8 feat: create ticket detail page
- #12 feat: add ticket status update feature
- #6 feat: create initial Prisma schema for ticket management

---

## 29. feat: implement notification model and basic notification list

### 概要
通知テーブルと通知一覧の初期実装を行う。

### 目的
担当者アサイン、SLA期限間近、エスカレーションなどのイベントをユーザーに知らせる土台を作る。

### タスク
- [ ] Notification モデルを作成する
- [ ] 通知種別を定義する
- [ ] アサイン時の通知作成処理を追加する
- [ ] エスカレーション時の通知作成処理を追加する
- [ ] 通知一覧画面または通知パネルを作成する
- [ ] 既読管理の初期方針を決める

### 完了条件
- 通知データが保存される
- 少なくともアサイン時に通知が作成される
- 画面上で通知一覧を確認できる

### 依存Issue
- #14 feat: add ticket assignee assignment feature
- #25 feat: add escalation workflow

---

## 30. feat: create realistic seed data for demo

### 概要
デモや動作確認に使える初期データを充実させる。

### 目的
初回セットアップ直後から主要画面の状態確認ができるようにする。

### タスク
- [ ] requester、agent、admin のユーザーを複数投入する
- [ ] カテゴリを複数投入する
- [ ] 未対応問い合わせを作成する
- [ ] 対応中問い合わせを作成する
- [ ] 解決済み問い合わせを作成する
- [ ] SLA超過問い合わせを作成する
- [ ] エスカレーション済み問い合わせを作成する
- [ ] コメントと履歴付きデータを作成する

### 完了条件
- seed 実行後に各画面確認に十分なデータが存在する
- 一覧、詳細、ダッシュボードでデータが確認できる
- 主要ユースケースのデモが可能になる

### 依存Issue
- #6 feat: create initial Prisma schema for ticket management
- #16 feat: record ticket history on updates
- #25 feat: add escalation workflow
- #28 feat: add FAQ candidate conversion feature

---

## 31. docs: create README first draft

### 概要
プロジェクトのREADME初版を作成する。

### 目的
第三者がこのアプリの目的、機能、技術構成、起動方法を理解できるようにする。

### タスク
- [ ] 概要を記載する
- [ ] 解決したい課題を記載する
- [ ] 主な機能一覧を記載する
- [ ] 技術スタックを記載する
- [ ] セットアップ手順を記載する
- [ ] 今後の改善案を記載する
- [ ] スクリーンショット掲載欄を用意する

### 完了条件
- README を読めばアプリ概要が分かる
- ローカル起動手順が分かる
- 主要機能と技術スタックが整理されている

### 依存Issue
- #1 feat: initialize Next.js project with Tailwind and ESLint
- #2 feat: set up Prisma with PostgreSQL

---

## 32. docs: add design documents under docs directory

### 概要
`docs/` 配下に設計資料を追加する。

### 目的
コードだけでなく、要件、画面設計、構成設計を整理し、開発意図が伝わる状態にする。

### タスク
- [ ] `docs/requirements.md` を作成する
- [ ] `docs/screen-flow.md` を作成する
- [ ] `docs/architecture.md` を作成する
- [ ] `docs/er-diagram.md` を作成する
- [ ] README から各ドキュメントへリンクする

### 完了条件
- docs 配下に主要設計資料が揃っている
- README から参照できる
- 第三者が設計意図を追える

### 依存Issue
- #31 docs: create README first draft

---

## 33. docs: create ER diagram and screen flow diagram

### 概要
ER図と画面遷移図を作成して docs に追加する。

### 目的
DB設計と画面導線を視覚的に伝え、GitHub 上での理解しやすさを高める。

### タスク
- [ ] ER図を作成する
- [ ] 主要エンティティとリレーションを記載する
- [ ] 画面遷移図を作成する
- [ ] 主要導線を明記する
- [ ] docs に保存する
- [ ] README にリンクを追加する

### 完了条件
- ER図が docs にある
- 画面遷移図が docs にある
- README から遷移できる

### 依存Issue
- #6 feat: create initial Prisma schema for ticket management
- #32 docs: add design documents under docs directory

---

## 34. test: add unit tests for core business logic

### 概要
主要な業務ロジックに単体テストを追加する。

### 目的
ステータス遷移やSLA判定などの重要ロジックの品質を担保する。

### タスク
- [ ] テスト実行環境を整える
- [ ] ステータス遷移判定のテストを書く
- [ ] SLA状態判定のテストを書く
- [ ] バリデーションロジックのテストを書く
- [ ] 正常系と異常系を網羅する
- [ ] テストコマンドを README に追記する

### 完了条件
- 主要ロジックに対する単体テストが存在する
- テストがローカルで実行できる
- 少なくとも3つ以上の重要ロジックがテストされている

### 依存Issue
- #22 feat: enforce valid ticket status transitions
- #24 feat: implement SLA due state and overdue display

---

## 35. test: add end-to-end test for core user flow

### 概要
主要な操作フローに対してE2Eテストを追加する。

### 目的
ログイン、問い合わせ登録、更新などの基本動作が画面上で成立していることを確認できるようにする。

### タスク
- [ ] Playwright を導入する
- [ ] ログインシナリオを作成する
- [ ] 問い合わせ登録シナリオを作成する
- [ ] ステータス更新シナリオを作成する
- [ ] コメント追加シナリオを作成する
- [ ] テスト用データ準備方法を整理する

### 完了条件
- 主要導線のE2Eテストが1本以上通る
- ログインから問い合わせ操作まで確認できる
- 再現可能な実行手順がある

### 依存Issue
- #4 feat: implement authentication with role support
- #10 feat: implement ticket creation form
- #12 feat: add ticket status update feature
- #15 feat: add ticket comment feature

---

## 36. infra: add Docker and docker compose setup

### 概要
アプリケーションとDBを Docker / Docker Compose で起動できるようにする。

### 目的
環境構築の再現性を高め、他者が手元で動かしやすい状態にする。

### タスク
- [ ] アプリ用 Dockerfile を作成する
- [ ] PostgreSQL を含む `docker-compose.yml` を作成する
- [ ] 環境変数の取り扱いを整理する
- [ ] 起動手順を README に記載する
- [ ] コンテナ上でアプリ起動を確認する
- [ ] Prisma migration / seed の実行方法を整理する

### 完了条件
- `docker compose up` でアプリとDBが起動する
- README に起動手順がある
- migration / seed まで再現手順が明確になっている

### 依存Issue
- #2 feat: set up Prisma with PostgreSQL
- #31 docs: create README first draft
