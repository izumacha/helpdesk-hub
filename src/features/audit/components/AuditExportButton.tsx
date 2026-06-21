'use client';

// 監査ログの拡張型 (チケット件名・変更者名含む)
import type { TicketHistoryWithRefs } from '@/data/ports/ticket-history-repository';

// AuditExportButton が受け取る props
interface Props {
  // サーバー側で取得済みのログ一覧 (CSVに変換して書き出す)
  logs: TicketHistoryWithRefs[];
}

// フィールド名の日本語ラベルマップ (CSV 出力にも日本語ヘッダーを使う)
const FIELD_LABELS: Record<string, string> = {
  status: 'ステータス',
  priority: '優先度',
  assignee: '担当者',
  escalation: 'エスカレーション',
};

// CSV セルを安全にエスケープする関数
// ダブルクォート・カンマ・改行を含む値はダブルクォートで囲み、内部のダブルクォートを 2 重化する
function escapeCSVCell(value: string | null | undefined): string {
  // null/undefined は空文字列として出力する
  if (value == null) return '';
  // 特殊文字が含まれる場合はクォート処理する
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// 監査ログを CSV ファイルとしてダウンロードするボタン
// ダウンロード処理はクライアント側で行う (サーバーへの追加リクエストなし)
export function AuditExportButton({ logs }: Props) {
  // CSV ダウンロードを実行するハンドラ
  function handleExport() {
    // CSV ヘッダー行 (各列の名前を日本語で定義する)
    const headers = ['日時', '担当者', '問い合わせ件名', '変更項目', '変更前', '変更後'];

    // データ行を組み立てる (各ログを CSV の 1 行に変換する)
    const rows = logs.map((log) => [
      // ISO 8601 形式の日時 (Excel で認識しやすいように '/' 区切りにする)
      log.createdAt.toLocaleString('ja-JP', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
      // 変更者氏名
      log.changedByName,
      // チケット件名
      log.ticketTitle,
      // 変更項目の日本語ラベル
      FIELD_LABELS[log.field] ?? log.field,
      // 変更前の値 (null の場合は空文字)
      log.oldValue ?? '',
      // 変更後の値 (null の場合は空文字)
      log.newValue ?? '',
    ]);

    // ヘッダーとデータ行をまとめて CSV 文字列に変換する
    const csvContent = [
      // ヘッダー行
      headers.map(escapeCSVCell).join(','),
      // データ行 (各フィールドをエスケープして結合)
      ...rows.map((row) => row.map(escapeCSVCell).join(',')),
    ].join('\n');

    // BOM 付き UTF-8 で出力する (Excel での文字化けを防ぐため BOM を先頭に付与)
    const bom = '﻿';
    const blob = new Blob([bom + csvContent], { type: 'text/csv;charset=utf-8;' });
    // ブラウザにダウンロードさせるための一時 URL を生成する
    const url = URL.createObjectURL(blob);

    // <a> タグを動的に作成してクリックすることでダウンロードを開始する
    const link = document.createElement('a');
    link.href = url;
    // ファイル名に現在日時を含める (ダウンロードフォルダで見つけやすくする)
    const now = new Date().toISOString().slice(0, 10); // YYYY-MM-DD 形式
    link.download = `audit-log-${now}.csv`;
    // DOM に追加してクリックし、すぐに削除する (メモリ節約)
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    // 一時 URL を解放してメモリリークを防ぐ
    URL.revokeObjectURL(url);
  }

  return (
    <button
      type="button"
      onClick={handleExport}
      // ログが 0 件の場合はボタンを無効化する (出力するデータがないため)
      disabled={logs.length === 0}
      className="rounded-lg border border-teal-300 bg-white px-4 py-2 text-sm font-semibold text-teal-800 shadow-sm transition hover:bg-teal-50 disabled:cursor-not-allowed disabled:opacity-40"
      // aria-label でボタンの目的を明示する (アイコンのみのボタンではないが補足のため)
      aria-label="監査ログを CSV 形式でダウンロードする"
    >
      CSV エクスポート
    </button>
  );
}
