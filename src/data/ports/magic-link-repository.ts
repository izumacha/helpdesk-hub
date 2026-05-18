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

  // tokenHash で 1 件取得 (見つからなければ null)。読み取り専用の検査用途
  findByTokenHash(tokenHash: string): Promise<MagicLinkToken | null>;

  // tokenHash で「未消費 かつ 失効前」のトークンを **原子的に** 消費する。
  // 検索 + 検証 + 消費印を 1 操作で行うことで、同一トークンの並行クリックでも
  // 高々 1 リクエストにしか成功させない (ワンタイム性をアプリ層ではなく DB 層で担保)。
  // 戻り値:
  //   - 該当行が見つかり消費に成功 → 消費前のドメイン型 (email を呼び出し側で利用)
  //   - 既に消費済み / 失効済み / 存在しない → null
  consumeValidToken(input: { tokenHash: string; now: Date }): Promise<MagicLinkToken | null>;

  // 指定 ID のトークンを 1 件物理削除する (メール送信失敗時の rollback 用)。
  // 失敗時に行を残すと countRecentByEmail のレート制限カウントを無意味に消費するため、
  // delivery 失敗が確定したタイミングで呼び出して掃除する
  deleteById(id: string): Promise<void>;

  // expiresAt が now より前のトークンを一括削除 (掃除用)。削除件数を返す
  deleteExpired(now: Date): Promise<number>;

  // 指定メール宛に since 以降に発行されたトークン件数を返す (発行レート制限用)
  countRecentByEmail(email: string, since: Date): Promise<number>;
}
