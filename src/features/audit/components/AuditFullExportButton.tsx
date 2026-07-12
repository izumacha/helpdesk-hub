'use client';

// ローディング状態を管理する
import { useState } from 'react';

/**
 * 監査ログの全履歴を CSV でダウンロードするボタン。
 *
 * AuditExportButton (現在表示中のページ分のみ、クライアント側で完結) と異なり、
 * GET /api/audit/export を叩いてサーバー側でキーセットカーソルを繰り返し前進させ、
 * 上限件数までの全履歴を 1 つの CSV にまとめて返してもらう (§4.2.1 フォローアップ再訪:
 * 「さらに読み込む」を手作業で辿らないと古い監査ログに一切到達できなかったギャップの解消)。
 *
 * ダウンロード処理・エラーハンドリングは CsvExportButton (tickets/export) と同じ設計を踏襲する。
 */

// Firefox では link.click() 直後に revokeObjectURL() を呼ぶとダウンロードが
// キャンセルされることがある。ブラウザがダウンロードを開始するまでの待機時間 (ミリ秒)。
const REVOKE_URL_DELAY_MS = 100;

export function AuditFullExportButton() {
  // ダウンロード中かどうかを管理する (多重クリック防止のため)
  const [loading, setLoading] = useState(false);

  // CSV ダウンロードを実行するハンドラ
  async function handleDownload() {
    setLoading(true);
    try {
      // fetch で CSV データを取得する (auth cookie はブラウザが自動付与する)
      const res = await fetch('/api/audit/export');
      if (!res.ok) {
        console.error(`[AuditFullExportButton] HTTP エラー: ${res.status}`);
        // ユーザーには内部詳細を含まない安全なメッセージのみ表示する (§9)
        throw new Error(
          res.status === 401
            ? 'セッションが切れました。ページを再読み込みしてからログインし直してください。'
            : res.status === 403
              ? 'この操作には管理者権限、または Pro / Enterprise プランが必要です。'
              : res.status === 429
                ? 'しばらくしてから再度お試しください（エクスポートの上限に達しました）。'
                : 'CSV エクスポートに失敗しました。しばらくしてから再度お試しください。',
        );
      }
      // サーバーが MAX_AUDIT_EXPORT_ROWS でレスポンスを打ち切った場合に X-Truncated: true を返す
      const truncated = res.headers.get('X-Truncated') === 'true';
      const rawLimit = res.headers.get('X-Total-Limit');
      const limitNum = rawLimit ? parseInt(rawLimit, 10) : NaN;
      // ヘッダー値を直接 alert に埋め込むと MitM でテキスト偽装が可能になるため (§9)、
      // 整数以外の値は信頼せず既定値にフォールバックする
      const totalLimit = Number.isFinite(limitNum) ? limitNum.toLocaleString('ja-JP') : '10,000';
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const revokeTimer = setTimeout(() => URL.revokeObjectURL(url), REVOKE_URL_DELAY_MS);
      try {
        const link = document.createElement('a');
        link.href = url;
        link.download = `audit-log-full-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      } catch (domErr) {
        clearTimeout(revokeTimer);
        URL.revokeObjectURL(url);
        throw domErr;
      }
      // 上限件数で打ち切られていた場合はユーザーに警告を表示する
      if (truncated) {
        alert(
          `監査ログ件数が上限 (${totalLimit} 件) を超えているため、CSV には最新の ${totalLimit} 件のみ含まれています。`,
        );
      }
    } catch (err) {
      console.error('[AuditFullExportButton] CSV エクスポートに失敗:', err);
      // TypeError はオフラインやネットワーク切断で fetch() が失敗したケース
      const message =
        err instanceof TypeError
          ? 'ネットワークエラーが発生しました。接続を確認してから再度お試しください。'
          : err instanceof Error
            ? err.message
            : 'CSV エクスポートに失敗しました。再度お試しください。';
      alert(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleDownload}
      disabled={loading}
      className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
      aria-label="監査ログの全履歴を CSV 形式でダウンロードする"
    >
      {loading ? '取得中…' : '全履歴をCSVエクスポート'}
    </button>
  );
}
