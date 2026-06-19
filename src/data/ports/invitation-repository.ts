// 招待リンクのドメイン型を参照
import type { Invitation } from '@/domain/types';
// 付与権限の型 (requester=メンバー / agent=担当者)
import type { Role } from '@/domain/types';

// テナントへのメンバー招待リンク (ワンタイムトークン) 保管リポジトリの契約 (port)。
// MagicLinkRepository と構造はほぼ同じだが、発行時点で参加先 (tenantId) と付与権限 (role) が
// 確定している点が異なる。受諾時はこのテーブルの tenantId を信頼の起点にし、リクエスト入力から
// テナントを注入させない (クロステナント参加の防止)。
export interface InvitationRepository {
  // 新しい招待を 1 件作成して保存する。tokenHash は呼び出し側で SHA-256 済みの値を渡す
  create(input: {
    tokenHash: string; // 生トークンの SHA-256 ハッシュ
    tenantId: string; // 参加先テナント ID (発行者のセッション由来のみを渡す契約)
    role: Role; // 参加後に付与する権限
    expiresAt: Date; // 失効時刻
    email?: string | null; // 宛先メール (任意)
    invitedById?: string | null; // 発行した admin の User ID (監査用、任意)
  }): Promise<Invitation>;

  // tokenHash で 1 件取得 (見つからなければ null)。読み取り専用の検査用途
  findByTokenHash(tokenHash: string): Promise<Invitation | null>;

  // tokenHash で「未消費 かつ 失効前」の招待を **原子的に** 消費する。
  // 検索 + 検証 + 消費印を 1 操作で行うことで、同一リンクの並行クリックでも高々 1 件しか
  // 成功させない (ワンタイム性を DB 層で担保。MagicLinkRepository と同じ思想)。
  // 戻り値:
  //   - 該当行が見つかり消費に成功 → 消費後のドメイン型 (tenantId / role を呼び出し側で利用)
  //   - 既に消費済み / 失効済み / 存在しない → null
  consumeValidToken(input: { tokenHash: string; now: Date }): Promise<Invitation | null>;

  // 指定 ID の招待を 1 件物理削除する (メール送信失敗時の rollback 用)
  deleteById(id: string): Promise<void>;

  // expiresAt が now より前の招待を一括削除 (掃除用)。削除件数を返す
  deleteExpired(now: Date): Promise<number>;

  // 指定テナント宛に since 以降に発行された招待件数を返す (発行レート制限用)
  countRecentByTenant(tenantId: string, since: Date): Promise<number>;
}
