// メールスレッド継続用の Message-ID 対応表リポジトリの契約 (port)。
//
// docs/smb-dx-pivot-plan.md Phase 2「スレッド継続 (In-Reply-To ヘッダで紐付け)」(§4 / L130)。
// 受信して起票したメール / 担当者が送信した返信メールの Message-ID を「どのチケットに属するか」と
// 一緒に記録し、後続の返信メール (In-Reply-To / References) からチケットを逆引きするために使う。
//
// セキュリティ不変条件 (§9): 突き合わせ・登録は必ず認証済み文脈で得た `tenantId` でスコープすること。
// 別テナントの Message-ID を参照させると、攻撃者が他テナントのチケットへコメントを差し込めてしまう
// (クロステナント漏洩) ため、Adapter 側でも tenantId を必ず where に含める。

// 対応表へ 1 件登録するときの入力値
export interface RegisterEmailThreadRefInput {
  messageId: string; // メールの Message-ID (山括弧と前後空白を除いた正規化済みの値)
  ticketId: string; // 紐づくチケット ID
  tenantId: string; // 所属テナント ID (セッション/宛先テナント由来必須)
}

// メールスレッド対応表リポジトリの契約 (port)
export interface EmailThreadRepository {
  /**
   * 受信メールの参照 Message-ID 群から、紐づく既存チケット ID を 1 件返す (tenantId スコープ)。
   * 複数ヒットした場合は最も新しく記録された対応を優先する。見つからなければ null。
   */
  findTicketIdByMessageIds(messageIds: string[], tenantId: string): Promise<string | null>;

  /**
   * Message-ID とチケットの対応を 1 件登録する (tenantId スコープ)。
   * 同一 (tenantId, messageId) が既にあれば何もしない (冪等: Webhook 再送でも安全)。
   */
  register(input: RegisterEmailThreadRefInput): Promise<void>;
}
