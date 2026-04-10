# 実装メモ

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
