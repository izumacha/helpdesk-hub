[← ドキュメント目次](./index.md)

# 画面遷移図

```mermaid
flowchart TD
    Start([ブラウザアクセス]) --> MW{"middleware<br/>認証チェック"}
    MW -- 未認証 --> Login["/login<br/>ログイン画面"]
    MW -- 認証済み --> Dashboard["/dashboard<br/>ダッシュボード"]
    Login -- ログイン成功 --> Dashboard

    Dashboard -- 件数カード クリック --> TicketList
    Dashboard -- サイドバー --> TicketList["/tickets<br/>問い合わせ一覧"]
    Dashboard -- サイドバー --> FAQ["/faq<br/>FAQ候補一覧"]
    Dashboard -- サイドバー --> Notifications["/notifications<br/>通知一覧"]

    TicketList -- 新規登録 --> TicketNew["/tickets/new<br/>チケット登録"]
    TicketList -- 件名クリック --> TicketDetail["/tickets/:id<br/>チケット詳細"]
    TicketList -- フィルタ/検索 --> TicketList
    TicketList -- ページネーション --> TicketList

    TicketNew -- 登録成功 --> TicketDetail

    TicketDetail -- ステータス変更 agent/admin --> TicketDetail
    TicketDetail -- 優先度変更 agent/admin --> TicketDetail
    TicketDetail -- 担当者変更 agent/admin --> TicketDetail
    TicketDetail -- コメント投稿 --> TicketDetail
    TicketDetail -- エスカレーション agent/admin --> TicketDetail
    TicketDetail -- FAQ候補登録 agent/admin,Resolved --> TicketDetail

    FAQ -- 公開/却下 --> FAQ
    Notifications -- 既読にする --> Notifications
    Notifications -- チケットを見る --> TicketDetail
```

## 画面一覧

| パス | 説明 | アクセス |
| --- | --- | --- |
| `/login` | ログイン | 全員（未認証） |
| `/dashboard` | ステータス別件数・ワークロード | 全員（認証済み） |
| `/tickets` | 問い合わせ一覧（検索・フィルタ・ページネーション） | 全員（requesterは自分の分のみ） |
| `/tickets/new` | 問い合わせ新規登録 | 全員（認証済み） |
| `/tickets/:id` | 問い合わせ詳細・更新 | 全員（requesterは自分の分のみ） |
| `/faq` | FAQ候補一覧・公開/却下管理 | agent / admin のみ |
| `/notifications` | 通知一覧・既読管理 | 全員（認証済み） |
