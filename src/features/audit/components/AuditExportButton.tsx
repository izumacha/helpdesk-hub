'use client';

// 監査ログの拡張型 (チケット件名・変更者名含む)
import type { TicketHistoryWithRefs } from '@/data/ports/ticket-history-repository';
// 変更履歴フィールドの日本語ラベルマップ (CSV のフィールド列に使う)
import { HISTORY_FIELD_LABELS } from '@/lib/constants';
// BOM 付き CSV 文字列生成 + CSV インジェクション対応済みエスケープ (lib/csv.ts に一元化)
// ローカルコピーを持たず常に共通実装を参照することでエスケープロジックの乖離を防ぐ (§6 DRY)
import { buildCsvString } from '@/lib/csv';

// AuditExportButton が受け取る props
interface Props {
  // サーバー側で取得済みのログ一覧 (CSVに変換して書き出す)
  logs: TicketHistoryWithRefs[];
}

// Firefox では link.click() 直後に revokeObjectURL() を呼ぶとダウンロードが
// キャンセルされることがある。ブラウザがダウンロードを開始するまでの待機時間 (ミリ秒)。
const REVOKE_URL_DELAY_MS = 100;

// 監査ログを CSV ファイルとしてダウンロードするボタン
// ダウンロード処理はクライアント側で行う (サーバーへの追加リクエストなし)
export function AuditExportButton({ logs }: Props) {
  // CSV ダウンロードを実行するハンドラ
  function handleExport() {
    // 予期しない例外をキャッチしてユーザーにフィードバックする (CLAUDE.md §6: エラーを握り潰さない)
    try {
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
        // 変更項目の日本語ラベル (constants.ts の HISTORY_FIELD_LABELS と同じ参照元を使う)
        HISTORY_FIELD_LABELS[log.field as keyof typeof HISTORY_FIELD_LABELS] ?? log.field,
        // 変更前の値 (null の場合は空文字)
        log.oldValue ?? '',
        // 変更後の値 (null の場合は空文字)
        log.newValue ?? '',
      ]);

      // BOM 付き UTF-8 の CSV 文字列を生成する。
      // buildCsvString が BOM・エスケープ・改行をまとめて処理する (DRY)。
      // \t を含むセル (OWASP 無害化後) も RFC 4180 準拠でダブルクォート囲みされる。
      const csv = buildCsvString(headers, rows);
      // Blob に変換してブラウザにダウンロードさせる準備をする
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      // ブラウザにダウンロードさせるための一時 URL を生成する
      const url = URL.createObjectURL(blob);
      // DOM 操作前にタイマーを登録することで、DOM 操作で例外が発生しても URL が確実に解放される。
      // catch ブロックで clearTimeout + 即時 revokeObjectURL を呼ぶことで二重解放を防ぐ。
      const revokeTimer = setTimeout(() => URL.revokeObjectURL(url), REVOKE_URL_DELAY_MS);
      try {
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
      } catch (domErr) {
        // DOM 操作に失敗した場合はタイマーをキャンセルして URL を即座に解放する
        clearTimeout(revokeTimer);
        URL.revokeObjectURL(url);
        // 外側の catch ブロックへ伝播させてユーザーに通知する
        throw domErr;
      }
    } catch (err) {
      // デベロッパーツールでエラー詳細を確認できるようにする (エラーを握り潰さない: CLAUDE.md §6)
      console.error('[AuditExportButton] CSV エクスポートに失敗:', err);
      // ユーザーには内部詳細を含まない安全なメッセージを表示する (§9)
      alert('監査ログのエクスポートに失敗しました。再度お試しください。');
    }
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
