[← ドキュメント目次](./index.md)

# 画面遷移図

```mermaid
flowchart TD
    Start([ブラウザアクセス]) --> MW{"middleware<br/>認証チェック"}
    MW -- 未認証 --> Login["/login<br/>ログイン画面"]
    MW -- 認証済み agent/admin --> Dashboard["/dashboard<br/>ダッシュボード"]
    MW -- 認証済み requester --> TicketList["/tickets<br/>問い合わせ一覧"]
    Login -- "ログイン成功 (パスワード / マジックリンク / SSO)" --> Dashboard

    Signup["/signup<br/>サインアップ"] -- "テナント作成完了 (メール認証)" --> Dashboard
    Invite["/invite/:token<br/>招待受諾"] -- 参加完了 --> Dashboard
    Help["/help<br/>ヘルプセンター"]

    Dashboard -- 件数カード クリック --> TicketList
    Dashboard -- サイドバー --> TicketList
    Dashboard -- サイドバー --> FAQ["/faq<br/>FAQ候補一覧"]
    Dashboard -- サイドバー --> Notifications["/notifications<br/>通知一覧"]
    Dashboard -- サイドバー admin --> Audit["/audit<br/>監査ログ"]
    Dashboard -- サイドバー admin --> Quarantine["/quarantine<br/>隔離メール/LINE"]
    Dashboard -- サイドバー admin --> Settings["/settings<br/>テナント設定"]

    TicketList -- 新規登録 --> TicketNew["/tickets/new<br/>チケット登録"]
    TicketList -- "CSV取り込み agent/admin" --> TicketImport["/tickets/import<br/>CSV一括取り込み"]
    TicketImport -- 取り込み完了 --> TicketList
    TicketList -- 件名クリック --> TicketDetail["/tickets/:id<br/>チケット詳細"]
    TicketList -- フィルタ/検索 --> TicketList
    TicketList -- ページネーション --> TicketList

    TicketNew -- 登録成功 --> TicketDetail

    TicketDetail -- ステータス変更 agent/admin --> TicketDetail
    TicketDetail -- 優先度変更 agent/admin --> TicketDetail
    TicketDetail -- 担当者変更 agent/admin --> TicketDetail
    TicketDetail -- コメント投稿・画像添付 --> TicketDetail
    TicketDetail -- エスカレーション agent/admin --> TicketDetail
    TicketDetail -- FAQ候補登録 agent/admin,Resolved --> TicketDetail

    FAQ -- 公開/却下 --> FAQ
    Notifications -- 既読にする --> Notifications
    Notifications -- チケットを見る --> TicketDetail

    Settings -- LINE 連携設定 --> SettingsLine["/settings/line<br/>LINE 連携"]
    Settings -- テナント新規作成 --> TenantNew["/settings/tenants/new<br/>テナント作成"]
```

> Web 画面以外の起票経路として、メール取り込み（`POST /api/inbound/email`）と LINE 取り込み（`POST /api/inbound/line`）があり、取り込めなかった受信は `/quarantine` に隔離される。SLA リマインダー・トライアルリマインダーは cron が `/api/internal/*` を叩いて通知を生成する。

## 画面一覧

| パス | 説明 | アクセス |
| --- | --- | --- |
| `/login` | ログイン（パスワード / マジックリンクのタブ切替。Enterprise は SSO も） | 全員（未認証） |
| `/signup` | セルフサーブサインアップ（テナント＋初代管理者の作成） | 全員（未認証） |
| `/invite/:token` | 招待リンクの受諾（テナントへのメンバー参加） | 全員（未認証・有効なトークン必須） |
| `/help` | ヘルプセンター（使い方・メール連携ガイド） | 全員（未認証） |
| `/dashboard` | ステータス別件数・ワークロード | 全員（認証済み） |
| `/tickets` | 問い合わせ一覧（検索・フィルタ・ページネーション） | 全員（requesterは自分の分のみ） |
| `/tickets/new` | 問い合わせ新規登録 | 全員（認証済み） |
| `/tickets/import` | CSV 一括取り込み | agent / admin |
| `/tickets/:id` | 問い合わせ詳細・更新・画像添付 | 全員（requesterは自分の分のみ） |
| `/faq` | FAQ候補一覧・公開/却下管理 | agent / admin のみ |
| `/notifications` | 通知一覧・既読管理 | 全員（認証済み） |
| `/audit` | 監査ログ閲覧・CSV 出力 | admin のみ（Pro / Enterprise プラン限定） |
| `/quarantine` | 隔離された受信メール / LINE メッセージの確認 | admin のみ |
| `/settings` | テナント設定（カテゴリ・拠点・メンバー招待・メール取り込み・SSO・通知チャネル・課金） | admin のみ |
| `/settings/line` | LINE 公式アカウント連携設定 | admin のみ |
| `/settings/tenants/new` | テナント新規作成 | admin のみ |
