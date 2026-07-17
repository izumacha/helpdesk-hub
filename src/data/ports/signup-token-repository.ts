// セルフサーブサインアップのドメイン型を参照
import type { SignupToken } from '@/domain/types';

// セルフサーブサインアップ (docs/smb-dx-pivot-plan.md §7.1) のワンタイムトークン保管リポジトリの
// 契約 (port)。MagicLinkRepository と構造・原子性の要件は同じ (単回使用を DB 層で担保する)。
export interface SignupTokenRepository {
  // 新しいサインアップトークンを 1 件作成して保存する。tokenHash は呼び出し側で SHA-256 済みの値を渡す
  create(input: {
    email: string; // サインアップ希望メール (小文字正規化済み)
    tokenHash: string; // 生トークンの SHA-256 ハッシュ
    expiresAt: Date; // 失効時刻
  }): Promise<SignupToken>;

  // tokenHash で 1 件取得 (見つからなければ null)。読み取り専用の検査用途
  findByTokenHash(tokenHash: string): Promise<SignupToken | null>;

  // tokenHash で「未消費 かつ 失効前」のトークンを **原子的に** 消費する。
  // 検索 + 検証 + 消費印を 1 操作で行うことで、同一リンクの並行クリックでも高々 1 件しか
  // 成功させない (ワンタイム性を DB 層で担保。MagicLinkRepository / InvitationRepository と同じ思想)。
  consumeValidToken(input: { tokenHash: string; now: Date }): Promise<SignupToken | null>;

  // 指定 ID のトークンを 1 件物理削除する (メール送信失敗時の rollback 用)
  deleteById(id: string): Promise<void>;

  // expiresAt が now より前のトークンを一括削除 (掃除用)。削除件数を返す
  deleteExpired(now: Date): Promise<number>;

  // 指定メール宛に since 以降に発行されたトークン件数を返す (発行レート制限用)
  countRecentByEmail(email: string, since: Date): Promise<number>;

  // 指定メール宛の「未消費 かつ 未失効」なトークンをすべて消費済み扱いにする (consumedAt を now にする)。
  // 監査で発見したギャップ対応: MagicLinkRepository.invalidateActiveByEmail と同じ理由・同じ実装方針
  // (再送のたびに古いリンクも有効なまま残ってしまう問題への対応。expiresAt ではなく consumedAt を
  // 書き換えるのは deleteExpired による早期物理削除で countRecentByEmail のカウントが狂うのを防ぐため)。
  invalidateActiveByEmail(email: string, now: Date): Promise<void>;
}
