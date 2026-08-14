[← ドキュメント目次](./index.md)

# security

## セキュリティ / 堅牢性メモ

このドキュメントは「実装の解説」ではなく、HelpDesk Hub を運用する際に必要な **脅威想定・制限・制約**をまとめたものです。

---

## 1. 脅威モデル（前提）

- **外部公開**（インターネットからアクセス可能）を前提にする場合
  - クレデンシャル総当たり、スパム、DoS（SSE・検索・一覧API）、権限昇格、CSRF/セッション固定などが主要リスク。
- **社内限定**（VPN/ゼロトラスト配下）を前提にする場合
  - 内部不正（権限濫用）・誤操作・大量操作による負荷が主要リスク。

このリポジトリは「最小限の堅牢化」を備えていますが、外部公開での本番運用は **追加の保護（WAF / Bot対策 / 監査 / インシデント対応）**が必要です。

---

## 2. レート制限（abuse対策）

### 2.1 Server Actions（ミューテーション）

`src/lib/rate-limit.ts` の **プロセス内 Map** によるスライディングウィンドウで、状態変更・コメント・エスカレーション等の連打による通知洪水を防ぎます。

```mermaid
flowchart LR
    Client["Client<br/>(フォーム送信 / ボタン連打)"]
    Action["Server Action"]
    Limiter{{"rate-limit.ts<br/>プロセス内 Map<br/>スライディングウィンドウ"}}
    OK["DB 更新 + 通知発火"]
    NG["拒否 (Error throw)"]

    SharedStore[("共有ストア<br/>Redis 等<br/>(複数インスタンス時の置き換え先)")]:::future

    Client --> Action
    Action -- "key = userId + action" --> Limiter
    Limiter -- "上限以内" --> OK
    Limiter -- "上限超過" --> NG
    Limiter -.-> SharedStore

    classDef future stroke-dasharray: 5 5,color:#666;
```

**制約**

- 水平スケール（複数インスタンス）では制限が分散します。
  - 本番で複数台運用する場合は Redis 等の共有ストアに置き換えてください。

### 2.2 API Routes（SSE含む）

- `GET /api/notifications/stream` は長時間接続のため、アプリ/プロキシのタイムアウト設定に影響されます。
- 外部公開の場合はロードバランサ/WAF側で「同一IPの同時接続数」「接続時間」「接続頻度」を制限するのが安全です。

---

## 3. SSE（通知ストリーム）の制約と対策

実装は `docs/architecture.md` に概要があります（SSE + `NotificationBroadcaster` ポート）。

### 3.1 水平スケール

- 既定は in-memory broadcaster のため **単一インスタンス前提**です。
- 水平スケールが必要なら、`NotificationBroadcaster` のアダプタを Redis pub/sub 等に切り替えます。

### 3.2 keep-alive とプロキシ

- SSE は `keep-alive` ping を送っています（`/api/notifications/stream`）。
- 逆プロキシ（Nginx 等）配下ではバッファリングを無効化し、タイムアウトを適切に設定してください。

---

## 4. 認証・セッション

認証経路は 3 つあり、いずれも Auth.js（v5）のセッション（JWT）に合流します。

| 経路                        | 実装                                                               | 備考                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| パスワード（Credentials）   | `src/lib/password-authorize.ts`                                    | bcrypt 検証                                                                                                                              |
| マジックリンク              | `src/lib/magic-link-authorize.ts`・`/api/auth/magic-link/callback` | トークンは SHA-256 ハッシュ保存・15 分 TTL・単回使用。サインアップ（`SignupToken`）・招待（`Invitation`）も同方式                        |
| SAML SSO（Enterprise 限定） | `/api/auth/sso/[tenantId]/{login,acs,metadata}`・`src/lib/saml.ts` | 署名・Issuer・Audience・期限を検証し、`SamlAssertionRef` でリプレイを拒否。セッション引き渡しは `MagicLinkToken`（`purpose=ssoHandoff`） |

- `NEXTAUTH_SECRET` は強い値を必ず設定してください（`.env.example` 参照）。
- **ログイン試行の制限はアプリ内に実装済み**: `src/lib/login-throttle.ts` がメールアドレス＋IP のスライディングウィンドウでパスワードログインの失敗連打をロックアウトします（マジックリンク経路には意図的に適用しない）。SSO エンドポイントには `src/lib/sso-rate-limit.ts` を適用。ただしこれらは**プロセス内 Map** のため §2.1 と同じ水平スケール制約があり、外部公開時の WAF / Bot 対策は引き続き多層防御として推奨します。

推奨（本番）

- HTTPS 終端を必須にし、Cookie の `Secure` を強制。

---

## 5. 監査・ログ（実装済み）

監査ログは 3 テーブルに分かれ、いずれも DB トリガで**追記専用**（UPDATE 拒否・DELETE は明示フラグ付きトランザクションのみ。`prisma/migrations/20260726000100_add_audit_log_immutability`）。

- **`TicketHistory`** — チケットの重要操作（ステータス・優先度・担当者・エスカレーション・カテゴリ・拠点の変更）を変更前後の値付きで記録。
- **`SettingsAuditLog`** — 管理者の設定変更（SSO・LINE・通知チャネル・拠点・カテゴリ・招待発行・プラン変更等）を記録。秘匿情報を含むため**値そのものは記録しない**（誰が・いつ・何をしたか、のみ）。
- **`AuthAuditLog`** — **全認証経路の成功・失敗を記録**（パスワード / マジックリンク / SAML SSO の 9 イベント種別）。書き込みは必ず `src/lib/auth-audit.ts` の `recordAuthAudit` 経由。失敗イベントにはイベント種別ごとに独立した書き込み上限があり、未認証で安く叩ける経路へのノイズ流入でパスワード失敗の記録が締め出される「監査の目潰し」を防ぐ。

閲覧 UI は `/audit`（admin のみ・Pro/Enterprise プラン限定。表示対象は `TicketHistory` と `SettingsAuditLog`）。CSV エクスポートあり（`/api/audit/export`）。**`AuthAuditLog` の閲覧 UI は現状なく、調査時は DB を直接参照する。**

残る推奨事項:

- レート制限（拒否）の件数モニタリング（現状はログのみ）

---

## 6. 取り込みチャネル・外部 Webhook の認証

- **メール取り込み**（`POST /api/inbound/email`）: テナント特定は宛先アドレスの `inboundToken`。送信元は SPF/DKIM/DMARC を確認し、未登録送信者・認証失敗などは起票せず隔離（`QuarantinedEmail`、`/quarantine` で admin が確認）。
- **LINE 取り込み**（`POST /api/inbound/line`）: `X-Line-Signature` を各テナントの `channelSecret` で HMAC-SHA256 検証。Webhook 再送は `LineMessageRef` で冪等化。
- **Stripe Webhook**（`POST /api/webhooks/stripe`）: 署名検証＋`stripeEventProcessedAt` による順序逆転（古いイベントでの巻き戻し）防止。

---

## 7. リクエストボディのサイズ上限（入口 / 経路 / リバースプロキシの三層）

ボディのサイズ上限は 3 つの層で決まる。**それぞれ守れる範囲が違うので、1 層だけでは足りない。**

| 層                         | 決める場所                                                                                                                  | 守れる範囲                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 入口（proxy のボディ複製） | `next.config.ts` の `experimental.proxyClientMaxBodySize`（値の導出は `src/lib/entry-body-limit.ts`）                       | アプリ全体で 1 つ。**経路ごとには絞れない**    |
| 経路                       | `readBodyWithinByteLimit` 系に渡す `maxBytes`（`webhook-body-limits.ts` / `ticket-body-limits.ts` / `auth-body-limits.ts`） | 経路ごとに厳密。超過は 413                     |
| リバースプロキシ           | アプリの手前（nginx なら `location` ごとの `client_max_body_size`）                                                         | 経路ごと。**アプリのプロセスに届く前**に切れる |

### 入口の枠を経路の最大値に合わせている理由と、その代償

Next.js は proxy（`src/proxy.ts`）を置いているアプリでは、非 GET/HEAD のボディを入口で複製してメモリにバッファする（proxy が本文を読むかどうかに関係なく走る）。`proxyClientMaxBodySize` 未設定だとこの複製は既定 10MB で頭打ちになり、**超過分はエラーにならず黙って切り捨てられて**ルートハンドラへ渡る。メール取り込み（25MB）・添付付きチケット書き込み（51MB）は 10MB を超えるため、既定のままだと正規のリクエストが壊れる（詳細は `src/lib/entry-body-limit.ts`）。

そのため入口の枠は経路別上限の最大値（＋超過を検知させる余白）に合わせてある。**代償として、上限が小さい未認証経路にも同じ枠が適用される。**

- 入口の複製は **proxy の認証判定より前**に走り、ルート側のレート制限・署名検証にはさらに手前で到達するため、アプリ層のゲートでは減らせない。
- したがって `POST /api/inbound/line`（経路の上限 256KB）や `POST /api/auth/magic-link/callback`（同 64KB）でも、入口では枠いっぱいまで滞留しうる。
- 加えて、入口の滞留には `request-body-limit.ts` の無通信（10 秒）／全体（120 秒）の期限が効かない（ルートは本文が届き切ってから起動するため）。ここを縛るのは入口の枠と Node の既定 `requestTimeout`（300 秒）だけ。

### 本番デプロイの要件

**アプリの手前にリバースプロキシを置き、経路ごとに本文サイズを絞ること。** 上記のとおりアプリ単体では経路別に絞れないため、これはアプリ側の設定漏れではなくデプロイ構成側の責務になる。nginx の例:

```nginx
# 既定は小さく。大きい本文を要する経路だけ個別に開ける。
# 値はいずれも「経路自身の上限より少しだけ大きく」する — 同値にすると、上限をわずかに
# 超えた本文が前段で切られてアプリ側の 413 とログに到達せず、運用者が
# 「正規の送信者が上限をわずかに超えている」のか「桁違いで探られている」のかを見分けられない。
#
# 既定値が 2m なのはこの規則の帰結。アプリ側で上限 1MB の経路（SSO ACS / Stripe Webhook）は
# 個別の location を持たず、この既定を継承する。ここを 1m にすると**その 2 経路だけ同値**に
# なり、上の理由でアプリ側の 413 とログが失われる — しかも SSO ACS は未認証で到達できる、
# 記録が最も要る側の経路である。
client_max_body_size 2m;                                   # 上限 1MB の経路（SSO ACS / Stripe）+ 1MB

location /api/inbound/email { client_max_body_size 26m; }  # 経路の上限 25MB + 1MB
location /api/tickets       { client_max_body_size 52m; }  # 経路の上限 51MB + 1MB
```

上限がさらに小さい経路（LINE 取り込み 256KB / マジックリンクのコールバック 64KB）を前段でも絞りたい場合は、同じ規則（経路の上限 + 余裕）で `location` を足す。足さなければ既定の 2m を継承するだけで、アプリ側の 413 とログは働く。

これは `src/lib/request-body-limit.ts` 冒頭が「塞ぐならアプリの外側」と書いている既知のギャップ（`/api/auth/[...nextauth]` は next-auth のハンドラが自前でボディを読むため、アプリ側から上限を差し替えられない）と同じ層の話で、同じリバースプロキシ設定でまとめて塞げる。

**Server Action は例外で、アプリ側に上限がある。** Next.js が `experimental.serverActions.bodySizeLimit`（未設定時の既定 **1MB**）を強制し、超過分は `413 Body exceeded ... limit` になる（`next/dist/server/app-render/action-handler.js`）。本リポジトリは未設定なので既定の 1MB が効いており、現状の最大ペイロード（CSV インポート／招待一括発行の `MAX_CSV_BYTES` = 512KB）はその内側に収まる。**1MB を超える本文を扱う Server Action を足すときは、リバースプロキシではなくこの設定を調整すること**（前段だけ広げても Next.js 側で 413 になる）。
