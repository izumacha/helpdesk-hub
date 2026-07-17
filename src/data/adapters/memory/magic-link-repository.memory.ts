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
        purpose: input.purpose ?? 'login', // 省略時は通常のログイン用マジックリンク扱い
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

    // tokenHash で「未消費かつ失効前」のトークンを原子的に消費する。
    // JS は単一スレッドのため、check + update の間に他の callback は割り込めない。
    // ただし関数本体で await を一切使わないことで、見た目上の同時呼び出し
    // (Promise.all([consume, consume])) でも片方しか成功しないことを保証する。
    async consumeValidToken({ tokenHash, now }) {
      // 全トークンを走査して tokenHash 一致のエントリを探す
      let target: { id: string; row: { consumedAt: Date | null; expiresAt: Date } } | null = null;
      for (const [id, row] of store.magicLinks) {
        if (row.tokenHash === tokenHash) {
          target = { id, row };
          break;
        }
      }
      // 該当なし
      if (!target) return null;
      // 既に消費済み
      if (target.row.consumedAt !== null) return null;
      // 失効済み
      if (target.row.expiresAt < now) return null;
      // 消費印を打って Map を上書き (await を挟まないので race にならない)
      const updated = { ...store.magicLinks.get(target.id)!, consumedAt: now };
      store.magicLinks.set(target.id, updated);
      // 呼び出し側へ防御的コピーを返す
      return { ...updated };
    },

    // 指定 ID を 1 件物理削除する (rollback 用)。存在しなければ何もしない
    async deleteById(id) {
      store.magicLinks.delete(id);
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

    // 指定メール宛に since 以降に発行された login 用途のトークン件数を数える。
    // purpose: 'login' で絞り、SSO ACS 発行の 'ssoHandoff' 行は対象外にする
    async countRecentByEmail(email, since) {
      let count = 0; // カウンタ
      // 全トークンを走査
      for (const t of store.magicLinks.values()) {
        // email 一致 + createdAt >= since + login 用途の条件で数える
        if (t.email === email && t.createdAt >= since && t.purpose === 'login') {
          count += 1;
        }
      }
      // 件数を返す
      return count;
    },

    // 指定メール宛の未消費・未失効・login 用途のトークンをすべて消費済み扱いにする
    // (consumedAt を now にする)。excludeId で直前に作成した新規トークン自身は対象外にする。
    // expiresAt ではなく consumedAt を書き換える理由・purpose で絞る理由は port の定義コメントを参照
    async invalidateActiveByEmail(email, now, excludeId) {
      for (const [id, t] of store.magicLinks) {
        // email 一致 + 未消費 + 未失効 (consumeValidToken と同じ gte 境界) + login 用途 +
        // 直前に作成した新規トークン自身は除外、の条件をすべて満たす行だけを対象にする
        if (
          t.email === email &&
          t.consumedAt === null &&
          t.expiresAt >= now &&
          t.purpose === 'login' &&
          id !== excludeId
        ) {
          store.magicLinks.set(id, { ...t, consumedAt: now });
        }
      }
    },
  };
}
