'use client';

// ローディング状態を管理する
import { useState } from 'react';
// Blob ダウンロードの共通処理 (CsvExportButton / AuditExportButton 系と共有。§6 DRY)
import { triggerBlobDownload } from '@/lib/blob-download';

/**
 * 隔離記録の全履歴を CSV でダウンロードするボタン。
 *
 * フォローアップ (2026-07-14 #3): 監査で発見したギャップの解消。/quarantine 画面は
 * 「さらに読み込む」によるキーセットページネーションしか持たず、200 件を超えるテナントでは
 * CSV エクスポート自体が存在しないため、admin が「登録し忘れたメンバーからの問い合わせが
 * 隔離されていないか」等をまとめて確認・保管する手段が無かった (/audit 画面が
 * §4.2.1/§4.2.2 で解消したのと同種のギャップ)。GET /api/quarantine/export を叩いて
 * サーバー側でキーセットカーソルを繰り返し前進させ、上限件数までの全履歴を 1 つの CSV に
 * まとめて返してもらう (AuditFullExportButton と同じ設計)。
 */
export function QuarantineExportButton() {
  // ダウンロード中かどうかを管理する (多重クリック防止のため)
  const [loading, setLoading] = useState(false);

  // CSV ダウンロードを実行するハンドラ
  async function handleDownload() {
    setLoading(true);
    try {
      // fetch で CSV データを取得する (auth cookie はブラウザが自動付与する)
      const res = await fetch('/api/quarantine/export');
      if (!res.ok) {
        console.error(`[QuarantineExportButton] HTTP エラー: ${res.status}`);
        // ユーザーには内部詳細を含まない安全なメッセージのみ表示する (§9)
        throw new Error(
          res.status === 401
            ? 'セッションが切れました。ページを再読み込みしてからログインし直してください。'
            : res.status === 403
              ? 'この操作には管理者権限が必要です。'
              : res.status === 429
                ? 'しばらくしてから再度お試しください（エクスポートの上限に達しました）。'
                : 'CSV エクスポートに失敗しました。しばらくしてから再度お試しください。',
        );
      }
      // サーバーが MAX_QUARANTINE_EXPORT_ROWS でレスポンスを打ち切った場合に X-Truncated: true を返す
      const truncated = res.headers.get('X-Truncated') === 'true';
      const rawLimit = res.headers.get('X-Total-Limit');
      const limitNum = rawLimit ? parseInt(rawLimit, 10) : NaN;
      // ヘッダー値を直接 alert に埋め込むと MitM でテキスト偽装が可能になるため (§9)、
      // 整数以外の値は信頼せず既定値にフォールバックする
      const totalLimit = Number.isFinite(limitNum) ? limitNum.toLocaleString('ja-JP') : '10,000';
      const blob = await res.blob();
      triggerBlobDownload(blob, `quarantine-full-${new Date().toISOString().slice(0, 10)}.csv`);
      // 上限件数で打ち切られていた場合はユーザーに警告を表示する
      if (truncated) {
        alert(
          `隔離記録の件数が上限 (${totalLimit} 件) を超えているため、CSV には最新の ${totalLimit} 件のみ含まれています。`,
        );
      }
    } catch (err) {
      console.error('[QuarantineExportButton] CSV エクスポートに失敗:', err);
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
      aria-label="隔離記録の全履歴を CSV 形式でダウンロードする"
    >
      {loading ? '取得中…' : '全履歴をCSVエクスポート'}
    </button>
  );
}
