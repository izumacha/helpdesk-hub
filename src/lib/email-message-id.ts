/**
 * Outbound email Message-ID helpers (Phase 2 スレッド継続).
 *
 * docs/smb-dx-pivot-plan.md Phase 2「スレッド継続 (In-Reply-To ヘッダで紐付け)」(§4 / L130)。
 * 担当者の返信を依頼者へメールで送るとき、決定的な Message-ID を付与する。依頼者がそのメールに
 * 返信すると In-Reply-To にこの Message-ID が載るので、受信 Webhook 側で「どのチケットへの返信か」を
 * 逆引きできる (EmailThreadRef に登録した正規化値と突き合わせる)。
 *
 * `header` はメールヘッダにそのまま入れる "<...>" 形式、`normalized` は対応表に登録/突き合わせる
 * 山括弧なしの値で、受信側の normalizeMessageId が返す表記に一致させる。
 */

// 衝突しない一意サフィックスを作るための UUID 生成 (Node 標準の crypto)
import { randomUUID } from 'node:crypto';

// Message-ID のドメイン部が未設定のときに使う既定ドメイン (取り込みドメインと揃える想定)
const DEFAULT_MESSAGE_ID_DOMAIN = 'helpdesk-hub.app';

// Message-ID のドメイン部を解決する。取り込みドメイン (INBOUND_EMAIL_DOMAIN) があれば流用し、
// 無ければ既定ドメインにフォールバックする (送受信で同じ前提に揃えるため一元化)。
export function resolveMessageIdDomain(): string {
  // 環境変数の前後空白を除く
  const configured = process.env.INBOUND_EMAIL_DOMAIN?.trim();
  // 値があればそれを、無ければ既定ドメインを使う
  return configured && configured.length > 0 ? configured : DEFAULT_MESSAGE_ID_DOMAIN;
}

// チケット返信メール用の Message-ID を組み立てる。
// header: ヘッダにそのまま入れる "<...>" 形式 / normalized: 対応表へ登録・突き合わせる正規化値。
export function buildReplyMessageId(
  ticketId: string,
  domain: string,
): { header: string; normalized: string } {
  // ticketId は cuid (英数字) なのでそのまま埋め込める。UUID を足して同一チケットでも一意にする
  const bare = `reply-${ticketId}-${randomUUID()}@${domain}`;
  // ヘッダ用は山括弧で囲む。登録用は山括弧なし (受信側 normalizeMessageId の戻り値と一致させる)
  return { header: `<${bare}>`, normalized: bare };
}
