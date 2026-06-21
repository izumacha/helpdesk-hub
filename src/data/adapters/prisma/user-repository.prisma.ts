// ユーザーリポジトリの契約 (port)、マッパー関数、Prisma 共通型をインポート
import type { UserRepository } from '@/data/ports/user-repository';
import { toUser, toUserSummary } from './mappers';
import type { PrismaLike } from './types';

// Prisma クライアントを使ったユーザーリポジトリを生成する関数
export function makeUserRepo(db: PrismaLike): UserRepository {
  return {
    // ID で 1 件取得 (認証フロー用。tenantId スコープなしでテナント横断検索)
    async findById(id) {
      const row = await db.user.findUnique({ where: { id } }); // 主キー検索
      return row ? toUser(row) : null; // 見つかれば変換、無ければ null
    },

    // メールアドレスで 1 件取得 (ログイン用。テナント横断検索)
    async findByEmail(email) {
      const row = await db.user.findUnique({ where: { email } }); // メール一致検索
      return row ? toUser(row) : null;
    },

    // 新規ユーザーを 1 件作成する (招待受諾・初代管理者登録用)
    async create(input) {
      // Prisma 経由で行を作成 (email の @unique 制約に反すると P2002 が投げられる)
      const row = await db.user.create({
        data: {
          email: input.email, // ログイン用メール (正規化済み)
          name: input.name, // 表示名
          passwordHash: input.passwordHash, // bcrypt 済みハッシュ
          role: input.role, // 付与する権限
          tenantId: input.tenantId, // 所属テナント
        },
      });
      // 作成行をドメイン型に変換して返す
      return toUser(row);
    },

    // 当該テナント内の agent または admin を名前順で取得 (担当者候補)
    async listAgents(tenantId) {
      const rows = await db.user.findMany({
        where: { tenantId, role: { in: ['agent', 'admin'] } }, // テナント + ロールで絞る
        select: { id: true, name: true }, // 必要列のみ
        orderBy: { name: 'asc' }, // 名前昇順
      });
      // 各行を UserSummary に変換
      return rows.map(toUserSummary);
    },

    // 当該テナント内の agent または admin の ID だけを取得 (通知一斉送信用)
    async listAgentIds(tenantId) {
      const rows = await db.user.findMany({
        where: { tenantId, role: { in: ['agent', 'admin'] } }, // テナント + ロールで絞る
        select: { id: true }, // id だけ
      });
      // id の配列に変換して返す
      return rows.map((r) => r.id);
    },

    // 指定 ID 配列に一致する当該テナント内ユーザーの概要を一括取得
    async findSummariesByIds(ids, tenantId) {
      // 空配列で findMany を呼ぶと無駄なので早期 return
      if (ids.length === 0) return [];
      const rows = await db.user.findMany({
        where: { tenantId, id: { in: ids } }, // テナント + IN 検索
        select: { id: true, name: true },
      });
      // UserSummary 形式に変換して返す
      return rows.map(toUserSummary);
    },

    // Phase 4 課金: テナント内のスタッフ (agent + admin) 数を返す (プランのシート上限チェック用)
    // requester (エンドユーザー) はシートを消費しない — ヘルプデスク製品の標準的な課金モデル
    async countByTenant(tenantId) {
      // agent と admin のみをカウントする (requester は上限対象外)
      return db.user.count({ where: { tenantId, role: { in: ['agent', 'admin'] } } });
    },
  };
}
