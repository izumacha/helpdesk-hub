// 隔離記録 (QuarantinedEmailRow[]) を CSV 文字列に変換する純粋関数。
//
// フォローアップ (2026-07-14 #3): §4.2.1/§4.2.2 で監査ログ (/audit) に追加した全履歴 CSV
// エクスポートと同じ設計を、隔離メール一覧 (/quarantine) にも適用する。画面 (page.tsx) と
// サーバー側の全履歴エクスポートルート (GET /api/quarantine/export) の両方がこの関数を
// 共有する（§6 DRY: audit-csv.ts と同じ「画面とエクスポートルートで列定義を共有する」方針）。

// 隔離記録 1 件分の型 (テナントスコープ絞り込み済み。/quarantine ページと共有)
import type { QuarantinedEmailRow } from '@/domain/types';
// 隔離理由・チャネルの日本語ラベル (画面と同じ参照元)
import { QUARANTINE_REASON_LABELS, QUARANTINE_CHANNEL_LABELS } from '@/lib/constants';
// BOM 付き CSV 文字列生成 + CSV インジェクション対応済みエスケープ (lib/csv.ts に一元化)
import { buildCsvString } from '@/lib/csv';

/**
 * 隔離記録の一覧を BOM 付き UTF-8 の CSV 文字列に変換する。
 * メール由来の行は送信者名/送信元アドレスを、LINE 由来の行は LINE ユーザー ID を持つ
 * (channel によって非 null な列が異なる)。本文は記録していない (§3.2 フォローアップ:
 * 件名・送信者だけで admin が判断できるため、本文は保存しない範囲最小化の方針)。
 */
export function quarantinedEmailRowsToCsv(logs: QuarantinedEmailRow[]): string {
  // CSV ヘッダー行 (各列の名前を日本語で定義する)
  const headers = ['日時', '経路', '送信者名', '送信元アドレス', 'LINEユーザーID', '件名', '理由'];

  // データ行を組み立てる (各隔離記録を CSV の 1 行に変換する)
  const rows = logs.map((log) => [
    // 日時 (Excel で認識しやすいように ja-JP ロケールで '/' 区切りにする。audit-csv.ts と同じ形式)
    log.createdAt.toLocaleString('ja-JP', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }),
    // 経路 (メール / LINE)
    QUARANTINE_CHANNEL_LABELS[log.channel],
    // 送信者名 (メール専用。LINE 記録・ヘッダから取れなかった場合は空文字)
    log.senderName ?? '',
    // 送信元アドレス (メール専用。LINE 記録では空文字)
    log.senderAddress ?? '',
    // LINE ユーザー ID (LINE 専用。メール記録・不明な場合は空文字)
    log.lineUserId ?? '',
    // 件名 (メール専用。LINE 記録では空文字)
    log.subject ?? '',
    // 隔離した理由の日本語ラベル
    QUARANTINE_REASON_LABELS[log.reason],
  ]);

  // ヘッダー + データ行を BOM 付き CSV 文字列にして返す
  return buildCsvString(headers, rows);
}
