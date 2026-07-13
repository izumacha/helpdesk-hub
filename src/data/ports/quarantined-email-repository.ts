// 隔離した受信メール/LINE メッセージ (QuarantinedEmail) リポジトリの契約 (port)。
// docs/smb-dx-pivot-plan.md §3.2 フォローアップ: 未登録送信者・プラン未対応・認証失敗等で
// 起票されなかった受信メールが admin から一切確認できなかったギャップを解消するための記録先。
// SettingsAuditLog (§4.2) と同じ「書き込み専用の監査的な記録 + テナント別一覧」という設計を踏襲する。
// フォローアップ (2026-07-13): LINE 取り込みも同じ隔離記録テーブルを共有するよう拡張した
// (channel で判別。型/Port/Adapter 名は移行コストを避けるため "email" のまま据え置く)。

// 隔離理由・チャネルの型
import type { QuarantineReason, QuarantineChannel, QuarantinedEmailRow } from '@/domain/types';

// 隔離記録を 1 件保存する際に渡す入力値。メール専用フィールド (senderAddress/senderName/subject)
// と LINE 専用フィールド (lineUserId) はどちらも channel に応じて呼び出し側が該当する方だけ渡す
export interface RecordQuarantinedEmailInput {
  tenantId: string; // 対象テナント
  channel: QuarantineChannel; // 隔離記録の発生元チャネル
  reason: QuarantineReason; // 隔離した理由
  senderAddress?: string | null; // 送信元メールアドレス (メール専用)
  senderName?: string | null; // 送信者名 (ヘッダから取れた場合のみ。メール専用)
  lineUserId?: string | null; // LINE ユーザー ID (LINE 専用)
  subject?: string | null; // 件名 (メール専用)
}

// キーセットページネーション用カーソル (この一覧は単一テーブルのみを表示するため、
// audit-pagination.ts の AuditPaginationCursor と異なり kind を持たない単純な 2 要素カーソル)
export interface QuarantinedEmailCursor {
  createdAt: Date; // 基準日時
  id: string; // 同一 createdAt の行同士を一意に順序付けるタイブレーカー
}

// 一覧取得時のフィルター条件
export interface QuarantinedEmailListFilter {
  tenantId: string; // テナントスコープ (必須。クロステナント漏洩防止)
  limit?: number; // 取得件数上限 (既定・上限は Adapter 側で resolveAuditLimit を共有する)
  before?: QuarantinedEmailCursor; // この日時 (と同時刻なら id) より前の行だけを対象にする
}

// 隔離済み受信メール書き込み用リポジトリの契約 (port)
export interface QuarantinedEmailRepository {
  record(input: RecordQuarantinedEmailInput): Promise<void>; // 隔離記録を 1 件追加する
  // テナント全体の隔離記録を新しい順に取得する (管理者専用)
  findAllByTenant(filter: QuarantinedEmailListFilter): Promise<QuarantinedEmailRow[]>;
}
