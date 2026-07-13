// SignupTokenRepository の契約 (port) をインポート
import type { SignupTokenRepository } from '@/data/ports/signup-token-repository';
// ドメイン型
import type { SignupToken } from '@/domain/types';
// メモリストア型と ID 生成関数
import { nextId, type Store } from './store';

// メモリストアを使った SignupToken リポジトリを生成する関数 (テスト用)
export function makeSignupTokenRepo(store: Store): SignupTokenRepository {
  return {
    // 新規トークンを 1 件作成してストアに登録
    async create(input) {
      // 新しいトークン行を組み立てる
      const token: SignupToken = {
        id: nextId(store, 'sut'), // 'sut_...' 形式の一意 ID
        email: input.email,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        consumedAt: null, // 作成直後は未消費
        createdAt: new Date(),
      };
      // ストアの Map に登録
      store.signupTokens.set(token.id, token);
      // 防御的コピーを返す (外から書き換えできないように)
      return { ...token };
    },

    // tokenHash で 1 件取得 (見つからなければ null)
    async findByTokenHash(tokenHash) {
      // 全トークンを走査し、tokenHash 一致のものを探す
      for (const t of store.signupTokens.values()) {
        if (t.tokenHash === tokenHash) {
          // 防御的コピーを返す
          return { ...t };
        }
      }
      // 見つからなければ null
      return null;
    },

    // tokenHash で「未消費かつ失効前」のトークンを原子的に消費する。
    // JS は単一スレッドのため、check + update の間に他の callback は割り込めない。
    // 関数本体で await を一切挟まないことで、見た目上の同時呼び出しでも片方しか成功しないことを保証する。
    async consumeValidToken({ tokenHash, now }) {
      // 全トークンを走査して tokenHash 一致のエントリを探す
      let targetId: string | null = null;
      for (const [id, t] of store.signupTokens) {
        if (t.tokenHash === tokenHash) {
          targetId = id;
          break;
        }
      }
      // 該当なし
      if (targetId === null) return null;
      // 対象行を取得
      const row = store.signupTokens.get(targetId)!;
      // 既に消費済み
      if (row.consumedAt !== null) return null;
      // 失効済み
      if (row.expiresAt < now) return null;
      // 消費印を打って Map を上書き (await を挟まないので race にならない)
      const updated = { ...row, consumedAt: now };
      store.signupTokens.set(targetId, updated);
      // 呼び出し側へ防御的コピーを返す
      return { ...updated };
    },

    // 指定 ID を 1 件物理削除する (rollback 用)。存在しなければ何もしない
    async deleteById(id) {
      store.signupTokens.delete(id);
    },

    // expiresAt が now より前のトークンを一括削除して件数を返す
    async deleteExpired(now) {
      let count = 0; // 削除件数カウンタ
      // 全トークンを走査
      for (const [id, t] of store.signupTokens) {
        // 失効済みのものだけ削除
        if (t.expiresAt < now) {
          store.signupTokens.delete(id);
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
      for (const t of store.signupTokens.values()) {
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
