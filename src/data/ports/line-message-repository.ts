// LINE メッセージ ID → チケット 対応表リポジトリの契約 (port)。
//
// docs/smb-dx-pivot-plan.md Phase 2「LINE 公式アカウント連携 (β)」(§4)。
// LINE の Webhook は at-least-once 配信で、応答が遅延/未受信だと同一メッセージを
// 5 分以内に再送してくる。このリポジトリはどの LINE メッセージ ID を既に起票済みかを記録し、
// 再送時に同じメッセージから二重にチケットを作らないための冪等化に使う
// (EmailThreadRepository の Message-ID 対応表と同じパターン)。
//
// セキュリティ不変条件 (§9): 突き合わせ・登録は必ず認証済み文脈で得た `tenantId` でスコープすること。
// 別テナントのメッセージ ID を参照させると、意図しないチケットの取り違えにつながるため
// (クロステナント漏洩) Adapter 側でも tenantId を必ず where に含める。

// 対応表へ 1 件登録するときの入力値
export interface RegisterLineMessageRefInput {
  lineMessageId: string; // LINE メッセージ ID (Webhook イベントの message.id)
  ticketId: string; // 紐づくチケット ID
  tenantId: string; // 所属テナント ID (Webhook 設定由来必須)
}

// LINE メッセージ対応表リポジトリの契約 (port)
export interface LineMessageRepository {
  /**
   * この LINE メッセージ ID が既に取り込み済みなら、紐づくチケット ID を返す (tenantId スコープ)。
   * 未処理なら null。
   */
  findTicketIdByMessageId(lineMessageId: string, tenantId: string): Promise<string | null>;

  /**
   * LINE メッセージ ID とチケットの対応を 1 件登録する (tenantId スコープ)。
   * 同一 (tenantId, lineMessageId) が既にあれば何もしない (冪等: Webhook 再送でも安全)。
   */
  register(input: RegisterLineMessageRefInput): Promise<void>;
}
