// マジックリンクトークンのドメイン型を参照
import type { MagicLinkToken } from '@/domain/types';

// マジックリンク (パスワードレス認証) のワンタイムトークン保管リポジトリ契約 (port)
// 発行時点ではユーザー (= テナント) が未確定なので、本ポートのメソッドは tenantId を取らない。
// 消費時に email から User を引き直して User.tenantId をセッションに載せる。
export interface MagicLinkRepository {
  // 新しいトークンを 1 件作成して保存する。tokenHash は呼び出し側で SHA-256 済みの値を渡す
  create(input: {
    email: string; // 送信先メール (小文字正規化済みであること)
    tokenHash: string; // 生トークンの SHA-256 ハッシュ
    expiresAt: Date; // 失効時刻
    requestedIp?: string | null; // 発行リクエスト元 IP (任意)
  }): Promise<MagicLinkToken>;

  // tokenHash で 1 件取得 (見つからなければ null)。消費・期限切れ判定は呼び出し側で行う
  findByTokenHash(tokenHash: string): Promise<MagicLinkToken | null>;

  // 指定 ID のトークンに consumedAt を立てて単回使用を強制する
  markConsumed(id: string): Promise<void>;

  // expiresAt が now より前のトークンを一括削除 (掃除用)。削除件数を返す
  deleteExpired(now: Date): Promise<number>;

  // 指定メール宛に since 以降に発行されたトークン件数を返す (将来のレート制限用)
  countRecentByEmail(email: string, since: Date): Promise<number>;
}
