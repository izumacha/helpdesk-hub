// チケット状態 (TicketStatus) の型を「正準 (Single Source of Truth)」であるドメイン型定義から読み込む
import type { TicketStatus } from '@/domain/types';
// テナントモード型 (lite | pro) を取り込み、mode-aware な遷移取得関数で使う
import type { TenantMode } from '@/domain/types';

// Source of truth for ticket status transitions. Mirrors `docs/requirements.html` §5
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
// mode 省略時は従来どおり Pro 表を引く (後方互換)。Lite テナントから呼ぶ場合は 'lite' を渡す。
export function isValidTransition(
  from: TicketStatus,
  to: TicketStatus,
  mode: TenantMode = 'pro',
): boolean {
  // mode-aware な遷移先一覧を引き、to が含まれていれば遷移可能
  return getAllowedTransitions(from, mode).includes(to);
}

// 現在状態 from から遷移できる次状態の一覧を配列で返す関数 (UI のプルダウン生成用)
// - mode 省略 / 'pro' の場合は従来どおり Pro 用 7 値遷移表 (ALLOWED_TRANSITIONS) を引く
// - mode === 'lite' かつ from が Lite 3 値のいずれかなら Lite 用遷移表を引く
// - mode === 'lite' でも from が非 Lite (例: 旧データの Escalated/Resolved 等) なら Pro 表に
//   フォールバックして「Lite に戻すための経路」を確保する (Pivot Plan §5.2)
export function getAllowedTransitions(
  from: TicketStatus,
  mode: TenantMode = 'pro',
): TicketStatus[] {
  // Lite モードかつ from が Lite 対応 3 値なら Lite 遷移表を返す (型ガードで narrow)
  if (mode === 'lite' && isLiteStatus(from)) {
    return ALLOWED_TRANSITIONS_LITE[from];
  }
  // それ以外は Pro 遷移表をそのまま返す (配列を共有するので呼び出し側で変更しないこと)
  return ALLOWED_TRANSITIONS[from];
}

// --- Lite モード (SMB 向け簡易モード) 用の縮約ステータスと遷移表 ---
// docs/smb-dx-pivot-plan.md §3.1 / §5.2 に対応。DB の TicketStatus enum は据え置き、
// Lite テナントの UI/業務上は 3 値だけ使う方針。
// 既存 Pro モード遷移表 (上記 ALLOWED_TRANSITIONS) には一切触れず追加のみ行う。

// Lite で扱う 3 ステータス。as const で readonly tuple 化し、型派生に使う
export const LITE_STATUSES = ['Open', 'InProgress', 'Closed'] as const;

// 上の tuple から union 型を導出 ('Open' | 'InProgress' | 'Closed')
export type LiteStatus = (typeof LITE_STATUSES)[number];

// Lite モードの遷移表 (Pivot plan §5.2)。自己遷移は不可、Closed → Open のみ再オープン許可
const ALLOWED_TRANSITIONS_LITE: Record<LiteStatus, LiteStatus[]> = {
  Open: ['InProgress', 'Closed'], // 未対応から対応中か完了へ
  InProgress: ['Open', 'Closed'], // 対応中から未対応に戻す or 完了へ
  Closed: ['Open'], // 完了から再オープンのみ (Pro モードと整合)
};

// 任意の TicketStatus が Lite で扱える 3 値のいずれかかを判定する型ガード関数
// (テナント mode 切替直後に旧データが Lite で表示されるケースなどで使用)
export function isLiteStatus(status: TicketStatus): status is LiteStatus {
  // 配列が readonly tuple なので includes は string キャストで判定
  return (LITE_STATUSES as readonly string[]).includes(status);
}

// Lite モード版: 現在状態 from から次状態 to に遷移してよいかを true/false で返す
export function isValidLiteTransition(from: LiteStatus, to: LiteStatus): boolean {
  // 許可表を参照し、to が含まれていれば遷移可能
  return ALLOWED_TRANSITIONS_LITE[from].includes(to);
}

// Lite モード版: 現在状態 from から遷移できる次状態の一覧を配列で返す (UI プルダウン用)
export function getAllowedLiteTransitions(from: LiteStatus): LiteStatus[] {
  // 許可表からそのまま返す (配列を共有するので呼び出し側で変更しないこと)
  return ALLOWED_TRANSITIONS_LITE[from];
}

// 新規起票時の初期ステータスを mode に応じて返す (Web フォーム / メール取り込み 共通の単一ルール)。
// - Lite テナント: 3 値の起点 'Open'(未対応) で起票する
// - Pro テナント: undefined を返し、DB 既定値 'New'(新規) に任せる (既存挙動を維持)
// 起票経路 (POST /api/tickets・メール取り込み 等) で同じ判定をコピーせず、ここを唯一の源にする。
export function initialStatusForMode(mode: TenantMode): TicketStatus | undefined {
  // Lite は 'Open'、それ以外 (pro) は undefined
  return mode === 'lite' ? 'Open' : undefined;
}
