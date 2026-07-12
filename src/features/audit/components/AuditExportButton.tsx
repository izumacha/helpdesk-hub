'use client';

// 監査ログ一覧が扱う統一行型 (チケット変更履歴 + 設定変更監査ログ / §4.2 フォローアップ)
import type { AuditFeedRow } from '@/features/audit/types';
// CSV 文字列への変換 (サーバー側の全履歴エクスポートと共有する純粋関数。§6 DRY)
import { auditFeedRowsToCsv } from '@/features/audit/audit-csv';

// AuditExportButton が受け取る props
interface Props {
  // サーバー側で取得済みのログ一覧 (CSVに変換して書き出す)
  logs: AuditFeedRow[];
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
      // BOM 付き UTF-8 の CSV 文字列を生成する (サーバー側の全履歴エクスポートと共有する
      // 純粋関数。ヘッダー・列定義・エスケープロジックの乖離を防ぐ §6 DRY)
      const csv = auditFeedRowsToCsv(logs);
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
