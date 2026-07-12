// 隔離済み受信メールリポジトリの契約 (port) と、メモリストア/ID 生成ヘルパーをインポート
import type {
  QuarantinedEmailRepository,
  QuarantinedEmailCursor,
} from '@/data/ports/quarantined-email-repository';
import type { QuarantinedEmail, QuarantinedEmailRow } from '@/domain/types';
import { nextId, type Store } from './store';
// 監査ログ系リポジトリ共通のページネーション上限・クランプ処理 (Prisma 実装と同一の値を使うことで
// テスト/本番の挙動を一致させる)
import { resolveAuditLimit } from '../audit-pagination';

// 行 (createdAt, id) がカーソルより前 (新しい順でカーソルより後ろ側 = まだ表示していない側) かを判定する。
// この一覧は単一テーブルのみを表示するため、audit-pagination.ts の isBeforeAuditCursor と異なり
// kind によるテーブル間の複合比較は不要 (単純な (createdAt, id) の 2 要素キーセット比較で足りる)
function isBeforeCursor(createdAt: Date, id: string, cursor: QuarantinedEmailCursor): boolean {
  const diff = createdAt.getTime() - cursor.createdAt.getTime();
  if (diff !== 0) return diff < 0;
  return id < cursor.id;
}

// メモリストアを使った隔離済み受信メールリポジトリを生成する関数
export function makeQuarantinedEmailRepo(store: Store): QuarantinedEmailRepository {
  return {
    // 隔離記録を 1 件保存する
    async record(input) {
      const row: QuarantinedEmail = {
        id: nextId(store, 'qte'), // 'qte_...' 形式の一意 ID
        tenantId: input.tenantId,
        reason: input.reason,
        senderAddress: input.senderAddress,
        senderName: input.senderName,
        subject: input.subject,
        createdAt: new Date(),
      };
      store.quarantinedEmails.set(row.id, row);
    },

    // テナント全体の隔離記録を取得する (テスト用メモリ実装)
    async findAllByTenant(filter) {
      // 件数上限 (DoS 対策としてクランプ。Prisma 実装と同じ上限値)
      const limit = resolveAuditLimit(filter.limit);

      const rows: QuarantinedEmailRow[] = [];
      for (const q of store.quarantinedEmails.values()) {
        // 当該テナント以外は対象外 (クロステナント漏洩防止)
        if (q.tenantId !== filter.tenantId) continue;
        // before が指定されていればカーソルより前の行だけを対象にする
        if (filter.before && !isBeforeCursor(q.createdAt, q.id, filter.before)) continue;
        rows.push({
          id: q.id,
          reason: q.reason,
          senderAddress: q.senderAddress,
          senderName: q.senderName,
          subject: q.subject,
          createdAt: q.createdAt,
        });
      }
      // 新しい順に並べる。createdAt が同値の行を安定した順序にするため id を第 2 キーにする
      rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
      return rows.slice(0, limit);
    },
  };
}
