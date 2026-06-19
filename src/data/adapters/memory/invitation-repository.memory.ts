// InvitationRepository の契約 (port) をインポート
import type { InvitationRepository } from '@/data/ports/invitation-repository';
// ドメイン型
import type { Invitation } from '@/domain/types';
// メモリストア型と ID 生成関数
import { nextId, type Store } from './store';

// メモリストアを使った Invitation リポジトリを生成する関数 (テスト用)
export function makeInvitationRepo(store: Store): InvitationRepository {
  return {
    // 新規招待を 1 件作成してストアに登録
    async create(input) {
      // 新しい招待行を組み立てる
      const invitation: Invitation = {
        id: nextId(store, 'inv'), // 'inv_...' 形式の一意 ID
        tokenHash: input.tokenHash,
        email: input.email ?? null,
        role: input.role,
        expiresAt: input.expiresAt,
        consumedAt: null, // 作成直後は未消費
        invitedById: input.invitedById ?? null,
        tenantId: input.tenantId,
        createdAt: new Date(),
      };
      // ストアの Map に登録
      store.invitations.set(invitation.id, invitation);
      // 防御的コピーを返す (外から書き換えできないように)
      return { ...invitation };
    },

    // tokenHash で 1 件取得 (見つからなければ null)
    async findByTokenHash(tokenHash) {
      // 全招待を走査し、tokenHash 一致のものを探す
      for (const inv of store.invitations.values()) {
        if (inv.tokenHash === tokenHash) {
          // 防御的コピーを返す
          return { ...inv };
        }
      }
      // 見つからなければ null
      return null;
    },

    // tokenHash で「未消費かつ失効前」の招待を原子的に消費する。
    // JS は単一スレッドのため、check + update の間に他の callback は割り込めない。
    // 関数本体で await を一切挟まないことで、見た目上の同時呼び出しでも片方しか成功しないことを保証する。
    async consumeValidToken({ tokenHash, now }) {
      // 全招待を走査して tokenHash 一致のエントリを探す
      let targetId: string | null = null;
      for (const [id, inv] of store.invitations) {
        if (inv.tokenHash === tokenHash) {
          targetId = id;
          break;
        }
      }
      // 該当なし
      if (targetId === null) return null;
      // 対象行を取得
      const row = store.invitations.get(targetId)!;
      // 既に消費済み
      if (row.consumedAt !== null) return null;
      // 失効済み
      if (row.expiresAt < now) return null;
      // 消費印を打って Map を上書き (await を挟まないので race にならない)
      const updated = { ...row, consumedAt: now };
      store.invitations.set(targetId, updated);
      // 呼び出し側へ防御的コピーを返す
      return { ...updated };
    },

    // 指定 ID を 1 件物理削除する (rollback 用)。存在しなければ何もしない
    async deleteById(id) {
      store.invitations.delete(id);
    },

    // expiresAt が now より前の招待を一括削除して件数を返す
    async deleteExpired(now) {
      let count = 0; // 削除件数カウンタ
      // 全招待を走査
      for (const [id, inv] of store.invitations) {
        // 失効済みのものだけ削除
        if (inv.expiresAt < now) {
          store.invitations.delete(id);
          count += 1;
        }
      }
      // 削除件数を返す
      return count;
    },

    // 指定テナント宛に since 以降に発行された招待件数を数える
    async countRecentByTenant(tenantId, since) {
      let count = 0; // カウンタ
      // 全招待を走査
      for (const inv of store.invitations.values()) {
        // tenantId 一致 + createdAt >= since の条件で数える
        if (inv.tenantId === tenantId && inv.createdAt >= since) {
          count += 1;
        }
      }
      // 件数を返す
      return count;
    },
  };
}
