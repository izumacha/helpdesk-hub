// LINE Webhook の連携コード処理 (紐付け成功/競合) 専用の冪等化記録リポジトリの契約 (port)。
//
// docs/smb-dx-pivot-plan.md §4 Phase 2.1 フォローアップ。連携コード送信での紐付け成立は
// 起票を伴わないため、lineMessages (LineMessageRef) 対応表の対象外になる。連携成功直後に
// Webhook 応答が遅延して LINE が同一メッセージを再送すると、2 回目はコードが既に消費済みで
// invalid になり、コード文字列そのものが本文の問い合わせとして誤起票され得た
// (src/lib/line-link-code-dedup.ts のコメント参照)。
//
// /code-review ultra 指摘対応: 従来はインプロセス Map (TTL 10分) で冪等化していたが、
// 連携成功直後 (TTL 以内) にプロセス再起動/デプロイが挟まると水平スケール前でも
// 冪等化が効かず誤起票が再現し得た。この Port を DB 永続化に切り替えて解消する。
// LINE メッセージ ID はプラットフォーム全体で一意なため、EmailThreadRepository /
// LineMessageRepository と異なり tenantId スコープは不要 (中身は一切保持しないため
// クロステナント漏洩の懸念もない)。連携コード処理は低頻度イベント (メンバー連携時のみ)
// のため、レコードは TTL で消さず永続保持する (件数は実運用でも小さい想定)。
export interface LineLinkCodeRepository {
  // messageId が既に連携コードとして処理済みかを判定する
  wasProcessed(messageId: string): Promise<boolean>;
  // messageId を「連携コードとして処理済み」として記録する (冪等: 既存なら何もしない)
  markProcessed(messageId: string): Promise<void>;
}
