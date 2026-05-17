// MagicLinkRepository の契約 (port) をインポート
import type { MagicLinkRepository } from '@/data/ports/magic-link-repository';
// ドメイン型
import type { MagicLinkToken } from '@/domain/types';
// メモリストア型と ID 生成関数
import { nextId, type Store } from './store';

// メモリストアを使った MagicLinkToken リポジトリを生成する関数 (テスト用)
export function makeMagicLinkRepo(store: Store): MagicLinkRepository {
  return {
    // 新規トークンを 1 件作成してストアに登録
    async create(input) {
      // 新しいトークン行を組み立てる
      const token: MagicLinkToken = {
        id: nextId(store, 'mlt'), // 'mlt_...' 形式の一意 ID
        email: input.email,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        consumedAt: null, // 作成直後は未消費
        requestedIp: input.requestedIp ?? null,
        createdAt: new Date(),
      };
      // ストアの Map に登録
      store.magicLinks.set(token.id, token);
      // 防御的コピーを返す (外から書き換えできないように)
      return { ...token };
    },

    // tokenHash で 1 件取得 (見つからなければ null)
    async findByTokenHash(tokenHash) {
      // 全トークンを走査し、tokenHash 一致のものを探す
      for (const t of store.magicLinks.values()) {
        if (t.tokenHash === tokenHash) {
          // 防御的コピーを返す
          return { ...t };
        }
      }
      // 見つからなければ null
      return null;
    },

    // 指定 ID に consumedAt を立てて単回使用を強制する
    async markConsumed(id) {
      // 対象トークンを取り出す
      const t = store.magicLinks.get(id);
      // 存在すれば consumedAt を現在時刻で上書きして再登録
      if (t) {
        store.magicLinks.set(id, { ...t, consumedAt: new Date() });
      }
    },

    // expiresAt が now より前のトークンを一括削除して件数を返す
    async deleteExpired(now) {
      let count = 0; // 削除件数カウンタ
      // 全トークンを走査
      for (const [id, t] of store.magicLinks) {
        // 失効済みのものだけ削除
        if (t.expiresAt < now) {
          store.magicLinks.delete(id);
          count += 1;
        }
      }
      // 削除件数を返す
      return count;
    },

    // 指定メール宛に since 以降に発行されたトークン件数を数える
    async countRecentByEmail(email, since) {
      let count = 0; // カウンタ
      // 全トークンを走査
      for (const t of store.magicLinks.values()) {
        // email 一致 + createdAt >= since の条件で数える
        if (t.email === email && t.createdAt >= since) {
          count += 1;
        }
      }
      // 件数を返す
      return count;
    },
  };
}
