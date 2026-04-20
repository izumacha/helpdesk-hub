// ユーザーリポジトリの契約 (port)、マッパー関数、Prisma 共通型をインポート
import type { UserRepository } from '@/data/ports/user-repository';
import { toUser, toUserSummary } from './mappers';
import type { PrismaLike } from './types';

// Prisma クライアントを使ったユーザーリポジトリを生成する関数
export function makeUserRepo(db: PrismaLike): UserRepository {
  return {
    // ID で 1 件取得し、ドメイン型 User に変換して返す
    async findById(id) {
      const row = await db.user.findUnique({ where: { id } }); // 主キー検索
      return row ? toUser(row) : null; // 見つかれば変換、無ければ null
    },

    // メールアドレスで 1 件取得 (ログインで使用)
    async findByEmail(email) {
      const row = await db.user.findUnique({ where: { email } }); // メール一致検索
      return row ? toUser(row) : null;
    },

    // agent または admin の一覧を名前順で取得 (UserSummary に変換)
    async listAgents() {
      const rows = await db.user.findMany({
        where: { role: { in: ['agent', 'admin'] } }, // agent か admin のみ
        select: { id: true, name: true }, // 必要列のみ
        orderBy: { name: 'asc' }, // 名前昇順
      });
      // 各行を UserSummary に変換
      return rows.map(toUserSummary);
    },

    // agent または admin の ID だけを取得 (通知一斉送信などに使用)
    async listAgentIds() {
      const rows = await db.user.findMany({
        where: { role: { in: ['agent', 'admin'] } },
        select: { id: true }, // id だけ
      });
      // id の配列に変換して返す
      return rows.map((r) => r.id);
    },

    // 指定 ID 配列に一致するユーザーの概要を一括取得
    async findSummariesByIds(ids) {
      // 空配列で findMany を呼ぶと無駄なので早期 return
      if (ids.length === 0) return [];
      const rows = await db.user.findMany({
        where: { id: { in: ids } }, // IN 検索
        select: { id: true, name: true },
      });
      // UserSummary 形式に変換して返す
      return rows.map(toUserSummary);
    },
  };
}
