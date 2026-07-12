// 監査ログ (AuditFeedRow[]) を CSV 文字列に変換する純粋関数。
//
// §4.2.1 フォローアップ再訪 (2026-07-12): 現在ページのみをダウンロードするクライアント側
// ボタン (AuditExportButton) と、全履歴を書き出すサーバー側ルート (GET /api/audit/export) の
// 両方が同じ列定義・同じラベル参照元を使う必要があるため、共有の純粋関数として抽出した
// (CLAUDE.md §6 DRY: 2 箇所目の複製が生じる前に共通化)。

// 監査ログ一覧が扱う統一行型 (チケット変更履歴 + 設定変更監査ログ)
import type { AuditFeedRow } from '@/features/audit/types';
// 変更履歴フィールド / 設定変更アクションの日本語ラベルマップ (CSV の列に使う)
import { HISTORY_FIELD_LABELS, SETTINGS_AUDIT_ACTION_LABELS } from '@/lib/constants';
// BOM 付き CSV 文字列生成 + CSV インジェクション対応済みエスケープ (lib/csv.ts に一元化)
import { buildCsvString } from '@/lib/csv';

/**
 * 監査ログ行の一覧を BOM 付き UTF-8 の CSV 文字列に変換する。
 * 設定変更行 (kind === 'settings') はチケットを持たず、値そのもの (秘匿情報を含みうる) も
 * 記録していないため、問い合わせ・変更前・変更後の列は空文字にする。
 */
export function auditFeedRowsToCsv(logs: AuditFeedRow[]): string {
  // CSV ヘッダー行 (各列の名前を日本語で定義する)
  const headers = ['日時', '担当者', '問い合わせ件名', '変更項目', '変更前', '変更後'];

  // データ行を組み立てる (各ログを CSV の 1 行に変換する)
  const rows = logs.map((log) => [
    // 日時 (Excel で認識しやすいように ja-JP ロケールで '/' 区切りにする)
    log.createdAt.toLocaleString('ja-JP', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }),
    // 変更者氏名
    log.actorName,
    // チケット件名 (設定変更行は該当なしのため空文字)
    log.kind === 'ticket' ? log.ticketTitle : '',
    // 変更項目の日本語ラベル (constants.ts の HISTORY_FIELD_LABELS / SETTINGS_AUDIT_ACTION_LABELS
    // と同じ参照元を使う)
    log.kind === 'ticket'
      ? (HISTORY_FIELD_LABELS[log.field as keyof typeof HISTORY_FIELD_LABELS] ?? log.field)
      : (SETTINGS_AUDIT_ACTION_LABELS[log.action] ?? log.action),
    // 変更前の値 (設定変更行・null の場合は空文字)
    log.kind === 'ticket' ? (log.oldValue ?? '') : '',
    // 変更後の値 (設定変更行・null の場合は空文字)
    log.kind === 'ticket' ? (log.newValue ?? '') : '',
  ]);

  // ヘッダー + データ行を BOM 付き CSV 文字列にして返す
  return buildCsvString(headers, rows);
}
