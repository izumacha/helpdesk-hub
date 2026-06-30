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

    // 当該テナント内の agent / admin の id + email を一括取得 (一斉メール送信用。N+1 回避)
    async listAgentEmails(tenantId) {
      const rows = await db.user.findMany({
        where: { tenantId, role: { in: ['agent', 'admin'] } }, // テナント + ロールで絞る
        select: { id: true, email: true }, // 必要列のみ
      });
      // { id, email } の配列をそのまま返す (追加の変換は不要)
      return rows;
    },

    // Phase 4 課金: テナント内のスタッフ (agent + admin) 数を返す (プランのシート上限チェック用)
    // requester (エンドユーザー) はシートを消費しない — ヘルプデスク製品の標準的な課金モデル
    async countByTenant(tenantId) {
      // agent と admin のみをカウントする (requester は上限対象外)
      return db.user.count({ where: { tenantId, role: { in: ['agent', 'admin'] } } });
    },

    // 紐付け済み LINE ユーザー ID から当該テナントのメンバーを 1 件引く (tenantId スコープ必須)
    async findByLineUserId(tenantId, lineUserId) {
      // (tenantId, lineUserId) は複合一意なので findFirst で最大 1 件
      const row = await db.user.findFirst({ where: { tenantId, lineUserId } });
      return row ? toUser(row) : null;
    },

    // メンバー起点でワンタイムコードのハッシュと失効時刻を自分のユーザー行に保存する。
    // tenantId スコープ付き updateMany で「自テナントの自分」だけを更新対象にする (他人を書き換えない)
    async setLineLinkCode(userId, tenantId, input) {
      await db.user.updateMany({
        where: { id: userId, tenantId },
        data: { lineLinkCodeHash: input.codeHash, lineLinkCodeExpiresAt: input.expiresAt },
      });
    },

    // 受信コードのハッシュに一致する有効な発行行を探し、原子的に lineUserId を紐付ける
    async linkLineUserByCode({ codeHash, tenantId, lineUserId, now }) {
      // 1) 有効な発行行 (同一テナント・未失効) を探す。無ければ「コードではない」
      const candidate = await db.user.findFirst({
        where: { tenantId, lineLinkCodeHash: codeHash, lineLinkCodeExpiresAt: { gte: now } },
      });
      if (!candidate) return { status: 'invalid' };

      // 2) その LINE ユーザー ID が既に誰かに連携済みかを確認する (テナント内一意制約の事前判定)
      const existing = await db.user.findFirst({ where: { tenantId, lineUserId } });
      if (existing && existing.id !== candidate.id) {
        // 別メンバーへ連携済み: 付け替えはしない (一意制約の衝突を避け、conflict を返す)
        return { status: 'conflict' };
      }

      // 3) 原子的に「コード消費 + lineUserId 設定」を行う。発行行がまだ有効な条件を where に再掲し、
      //    並行リクエストでの二重処理を防ぐ (count===1 のときだけ成功扱い)
      try {
        const result = await db.user.updateMany({
          where: {
            id: candidate.id,
            lineLinkCodeHash: codeHash,
            lineLinkCodeExpiresAt: { gte: now },
          },
          data: { lineUserId, lineLinkCodeHash: null, lineLinkCodeExpiresAt: null },
        });
        // 0 件 = 並行処理に先を越された (既に消費済み)。コードとしては無効扱いにする
        if (result.count !== 1) return { status: 'invalid' };
        // 連携成功 (このメンバーに lineUserId が結び付いた)
        return { status: 'linked', userId: candidate.id };
      } catch (err) {
        // (tenantId, lineUserId) 一意制約違反 (P2002): 事前判定をすり抜けた競合で別メンバーが先に連携。
        // 付け替え不能として conflict を返す (それ以外の例外は想定外なので上位へ送出)。
        if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2002') {
          return { status: 'conflict' };
        }
        throw err;
      }
    },

    // メンバー起点で LINE 連携を解除する (lineUserId と発行中コードをまとめてクリア)
    async unlinkLineUser(userId, tenantId) {
      await db.user.updateMany({
        where: { id: userId, tenantId },
        data: { lineUserId: null, lineLinkCodeHash: null, lineLinkCodeExpiresAt: null },
      });
    },
  };
}
