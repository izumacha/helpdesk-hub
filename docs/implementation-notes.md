[← ドキュメント目次](./index.md) / 実装メモ

# 実装メモ

> **本書は日付付きの歴史的記録**であり、当時の API 名・状況をそのまま残している。現在の実装と名称が
> 異なる場合があるため、**現行の正本は各エントリに記載のソースファイルを参照**すること。

## 2026-04-10

`docs/requirements.md` の「5. ステータス遷移」をもとに、チケット状態遷移のドメインロジックを追加しました。

- `src/domain/ticket-status.ts`
  - `TicketStatus` の型定義
  - 遷移ルール定義（`STATUS_TRANSITION_RULES`）
  - 遷移可否判定（`canTransition`）
  - 不正遷移エラー（`InvalidStatusTransitionError`）
  - サーバ側バリデーション用の `assertValidTransition`
- `tests/ticket-status.test.ts`
  - 許可遷移 / 不正遷移 / 再オープン遷移のテストを追加

> 備考: 依存関係のインストール制約により、この環境では test 実行は未完了。
>
> **【追記 2026-08-09】現行実装との対応**: 上記の名称はその後のリファクタで変更済みで、
> `STATUS_TRANSITION_RULES` / `canTransition` / `InvalidStatusTransitionError` / `assertValidTransition`
> はいずれも現行ソースに存在しない。現在の `src/domain/ticket-status.ts` は、遷移表を
> モジュール内部の定数 `ALLOWED_TRANSITIONS`（Pro）/ `ALLOWED_TRANSITIONS_LITE`（Lite）として
> 定義し（**定数自体は export されない**）、外部へは `isValidTransition` / `getAllowedTransitions`
> 等の関数のみを公開する。遷移仕様は [`requirements.md` §5](./requirements.md#5-ステータス遷移)、
> 実装上の単一の真実は `src/domain/ticket-status.ts` を参照。テストは `tests/ticket-status.test.ts`
> で通過済み。
