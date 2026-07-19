/**
 * SLA due-soon reminder helpers (pure logic — no I/O).
 *
 * issue-backlog.md #20「通知機能（アサイン/期限/更新）」フォローアップ。
 * 監査で発見したギャップ: SLA 期限が近いことは一覧・詳細画面のバッジ (src/lib/sla.ts の
 * getSlaState が 'warning' を返す状態) でしか分からず、担当者が画面を開かない限り気づけない。
 * 定期実行のリマインダー (アプリ内通知) が無いため、対応漏れのまま期限超過に至る事故を防ぐために追加する。
 *
 * すべて副作用のない純粋関数なのでユニットテスト (tests/sla-reminder.test.ts) で網羅できる。
 * 実際の一覧取得・通知作成は呼び出し側 (POST /api/internal/sla-reminders) が担う。
 */

// SLA 状態判定 (ok/warning/overdue/none) は既存の一元管理された定義をそのまま再利用する
// (§6 一元管理: 「期限間近」の閾値をここで再定義すると、一覧画面のバッジ表示と定義がずれる恐れがある)
import { getSlaState } from '@/lib/sla';

// このリマインダーの判定対象になる最小限のチケット情報
export interface SlaReminderCandidate {
  resolutionDueAt: Date | null; // 解決期限 (SLA)
  resolvedAt: Date | null; // 解決日時 (未解決なら null)
  assigneeId: string | null; // 担当者 (未アサインなら通知先が無いので対象外)
  // 直近に通知済みの resolutionDueAt (未通知/対象外なら null)。resolutionDueAt と一致していれば
  // 既に同じ期限に対して通知済みとみなす (優先度変更等で期限が再計算されれば自動的に再アームされる)
  slaReminderNotifiedForDueAt: Date | null;
}

// 内部一覧取得の上限件数 (§8 一覧取得は必ず上限を持たせる)。SMB 向け SaaS の想定規模
// (テナントあたり数十〜数百件の未解決チケット程度) では 1 回の cron 実行で十分に収まる件数
export const SLA_DUE_SOON_QUERY_LIMIT = 500;

// 指定チケットに SLA 期限接近リマインダーを送るべきかを判定する純粋関数。
// 条件: (1) SLA 状態が 'warning' (getSlaState と同じ定義。期限間近かつ未解決)
//       (2) 担当者が割り当て済み (通知先が決まっている)
//       (3) 現在の resolutionDueAt に対してまだ通知していない
export function needsSlaDueSoonReminder(ticket: SlaReminderCandidate): boolean {
  // 期限未設定 (resolutionDueAt が null) なら getSlaState が 'none' を返すため自然に対象外になる
  const state = getSlaState(ticket.resolutionDueAt, ticket.resolvedAt);
  // 'warning' (期限間近) 以外 ('ok' / 'overdue' / 'none') は対象外。
  // 'overdue' (既に超過) を含めないのは意図的な選択: 超過は既に一覧・詳細画面のバッジで
  // 常時警告されており、このリマインダーは「まだ間に合ううちに気づいてもらう」ことが目的のため
  if (state !== 'warning') return false;
  // 担当者未アサインなら通知先が無いので対象外
  if (!ticket.assigneeId) return false;
  // resolutionDueAt は state が 'warning' の時点で null ではないことが保証されている
  // (getSlaState は null なら 'none' を返す) が、TypeScript の型情報上はまだ Date | null なので
  // ここで明示的にガードする
  if (!ticket.resolutionDueAt) return false;
  // 直近の通知が今と同じ resolutionDueAt に対してであれば、既に通知済みなので再送しない
  if (ticket.slaReminderNotifiedForDueAt?.getTime() === ticket.resolutionDueAt.getTime()) {
    return false;
  }
  // 上記のいずれにも該当しなければ通知が必要
  return true;
}

// SLA 期限接近リマインダーの通知本文を組み立てる純粋関数 (副作用なし)
export function renderSlaDueSoonMessage(title: string): string {
  return `チケット「${title}」の解決期限が近づいています`;
}
