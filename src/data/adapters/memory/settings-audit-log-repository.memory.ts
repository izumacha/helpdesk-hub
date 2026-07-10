// 設定変更監査ログリポジトリの契約 (port) と、メモリストア/ID 生成ヘルパーをインポート
import type {
  SettingsAuditLogRepository,
  SettingsAuditLogWithRefs,
} from '@/data/ports/settings-audit-log-repository';
import type { SettingsAuditLog } from '@/domain/types';
import { nextId, type Store } from './store';
// 監査ログ系リポジトリ共通のページネーション上限・クランプ処理・複合カーソル比較 (ticket-history-repository
// と共有。Prisma 実装と同一の値・比較規則を使うことでテスト/本番の挙動を一致させる)
import { resolveAuditLimit, isBeforeAuditCursor } from '../audit-pagination';
// actorId が null (システムによる自動変更) のときに表示する操作者名の一元管理定数
import { SETTINGS_AUDIT_SYSTEM_ACTOR_NAME } from '@/lib/constants';

// メモリストアを使った設定変更監査ログリポジトリを生成する関数
export function makeSettingsAuditLogRepo(store: Store): SettingsAuditLogRepository {
  return {
    // 監査ログを 1 件記録する
    async record(input) {
      // 新しい監査ログ行を組み立てる
      const row: SettingsAuditLog = {
        id: nextId(store, 'sal'), // 'sal_...' 形式の一意 ID
        tenantId: input.tenantId, // 対象テナント
        actorId: input.actorId, // 操作者
        action: input.action, // 実行された操作の種別
        createdAt: new Date(), // 操作日時
      };
      // ストアに登録 (返り値はなし)
      store.settingsAuditLogs.set(row.id, row);
    },

    // テナント全体の設定変更監査ログを取得する (テスト用メモリ実装)
    async findAllByTenant(filter) {
      // 件数上限 (DoS 対策としてクランプ。Prisma 実装と同じ上限値)
      const limit = resolveAuditLimit(filter.limit);
      const offset = filter.offset ?? 0;

      // メモリストアからテナントスコープで絞り込む
      const rows: SettingsAuditLogWithRefs[] = [];
      for (const log of store.settingsAuditLogs.values()) {
        // 当該テナント以外は対象外 (クロステナント漏洩防止)
        if (log.tenantId !== filter.tenantId) continue;
        // §4.2.1 フォローアップ再訪: before が指定されていればカーソルより前の行だけを対象にする
        // (複合キーセットカーソル。自分のテーブル種別 'settings' を渡し、TicketHistory との
        // マージ境界でも正しく判定させる)
        if (
          filter.before &&
          !isBeforeAuditCursor(log.createdAt, 'settings', log.id, filter.before)
        ) {
          continue;
        }
        // 操作者を取得する (actorId が null ならシステム操作なので lookup 自体をスキップする)
        const user = log.actorId ? store.users.get(log.actorId) : undefined;
        rows.push({
          id: log.id, // 監査ログ ID
          actorId: log.actorId, // 操作者 ID (null ならシステム操作)
          // 操作者氏名: actorId が null ならシステムアクター名、見つからなければ「不明」
          actorName: log.actorId ? (user?.name ?? '不明') : SETTINGS_AUDIT_SYSTEM_ACTOR_NAME,
          action: log.action, // 実行された操作の種別
          createdAt: log.createdAt, // 操作日時
        });
      }
      // 新しい順に並べてページネーションを適用する。createdAt が同値の行を安定した順序にするため
      // id を第 2 キーにする (Prisma アダプタの orderBy [{createdAt:'desc'},{id:'desc'}] と対にする)
      rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
      return rows.slice(offset, offset + limit);
    },
  };
}
