// チケット状態 (TicketStatus) の型を Prisma (DB 操作ライブラリ) が生成した定義から読み込む
import type { TicketStatus } from '@/generated/prisma';

// Source of truth for ticket status transitions. Mirrors `docs/requirements.md` §5
// including `Closed → Open`（再オープン）which is an explicit product requirement,
// not an oversight. Changing this table requires updating the requirements doc
// and `tests/ticket-status.test.ts` together.
// 以下は「どの状態からどの状態へ変えてよいか」を表す表 (遷移許可リスト)
const ALLOWED_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  New: ['Open', 'WaitingForUser', 'InProgress', 'Resolved', 'Closed'], // 新規作成直後からはほぼ全状態へ進める
  Open: ['InProgress', 'WaitingForUser', 'Escalated', 'Resolved', 'Closed'], // 受付済みから作業中・上位対応など
  WaitingForUser: ['Open', 'InProgress', 'Resolved', 'Closed'], // 依頼者回答待ちから再開・解決など
  InProgress: ['WaitingForUser', 'Escalated', 'Resolved', 'Closed'], // 作業中から保留・エスカレーション・解決
  Escalated: ['InProgress', 'Resolved', 'Closed'], // エスカレーション後は作業再開か解決/完了のみ
  Resolved: ['Open', 'Closed'], // 解決済みは再オープンまたは完了へ
  Closed: ['Open'], // 完了からでも再オープン可 (要件定義で明示)
};

// 現在状態 from から次状態 to に遷移してよいかを true/false で返す関数
export function isValidTransition(from: TicketStatus, to: TicketStatus): boolean {
  // 許可表を参照し、to が含まれていれば遷移可能
  return ALLOWED_TRANSITIONS[from].includes(to);
}

// 現在状態 from から遷移できる次状態の一覧を配列で返す関数 (UI のプルダウン生成用)
export function getAllowedTransitions(from: TicketStatus): TicketStatus[] {
  // 許可表からそのまま返す (配列を共有するので呼び出し側で変更しないこと)
  return ALLOWED_TRANSITIONS[from];
}
