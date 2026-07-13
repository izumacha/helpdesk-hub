// 隔離済み受信メールリポジトリの契約 (port) と Prisma 共通型をインポート
import type { QuarantinedEmailRepository } from '@/data/ports/quarantined-email-repository';
import type { PrismaLike } from './types';
// 監査ログ系リポジトリ共通のページネーション上限・クランプ処理 (settings-audit-log-repository と共有)
import { resolveAuditLimit } from '../audit-pagination';

// Prisma クライアントを使った隔離済み受信メールリポジトリを生成する関数
export function makeQuarantinedEmailRepo(db: PrismaLike): QuarantinedEmailRepository {
  return {
    // 隔離記録を 1 件保存する (戻り値なし)
    async record(input) {
      await db.quarantinedEmail.create({
        data: {
          tenantId: input.tenantId,
          channel: input.channel,
          reason: input.reason,
          senderAddress: input.senderAddress ?? null,
          senderName: input.senderName ?? null,
          lineUserId: input.lineUserId ?? null,
          subject: input.subject ?? null,
        },
      });
    },

    // テナント全体の隔離記録を取得する
    // テナントスコープを必ず適用してクロステナント漏洩を防ぐ
    async findAllByTenant(filter) {
      // 件数上限をクランプ (DoS・リソース枯渇防止)
      const limit = resolveAuditLimit(filter.limit);

      const rows = await db.quarantinedEmail.findMany({
        where: {
          tenantId: filter.tenantId, // テナントスコープ
          // before が指定されていれば「それより前」の行だけに絞る (単一テーブルの
          // キーセットカーソル。ticket-history/settings-audit のような kind 分岐は不要)
          ...(filter.before && {
            OR: [
              { createdAt: { lt: filter.before.createdAt } },
              { createdAt: filter.before.createdAt, id: { lt: filter.before.id } },
            ],
          }),
        },
        // 新しい順に並べる。createdAt が同値の行を安定した順序にするため id を第 2 キーにする
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
      });

      return rows.map((row) => ({
        id: row.id,
        channel: row.channel,
        reason: row.reason,
        senderAddress: row.senderAddress,
        senderName: row.senderName,
        lineUserId: row.lineUserId,
        subject: row.subject,
        createdAt: row.createdAt,
      }));
    },
  };
}
