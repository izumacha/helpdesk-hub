'use client';

// URL クエリパラメータを読み取る (Suspense 境界が必要)
import { useSearchParams } from 'next/navigation';
// ローディング状態を管理する
import { useState } from 'react';
// Blob ダウンロードの共通処理 (AuditExportButton / AuditFullExportButton と共有。
// /code-review ultra 指摘対応: 3 ボタンが同じ「Blob URL 生成→クリック→解放」を複製していた §6 DRY)
import { triggerBlobDownload } from '@/lib/blob-download';

/**
 * チケット一覧の現在の絞り込み条件を維持したまま CSV をダウンロードするボタン。
 *
 * useSearchParams() でブラウザの URL クエリパラメータをそのまま
 * GET /api/tickets/export に転送するため、一覧ページとエクスポートが
 * 常に同じ絞り込み条件を使う (issue-backlog #27 完了条件「一覧条件を引き継いだ CSV ダウンロード可能」)。
 *
 * Suspense 境界内に配置しないと Next.js でビルドエラーになる。
 * 呼び出し側 (tickets/page.tsx) で <Suspense> でラップすること。
 */

export function CsvExportButton() {
  // ブラウザの現在の URL クエリパラメータを取得する (Suspense 必須)
  const searchParams = useSearchParams();
  // ダウンロード中かどうかを管理する (多重クリック防止のため)
  const [loading, setLoading] = useState(false);

  // CSV ダウンロードを実行するハンドラ
  async function handleDownload() {
    // ダウンロード中は再クリックを防ぐ
    setLoading(true);
    try {
      // 現在の URL クエリパラメータをそのまま export エンドポイントに転送する
      // (一覧の絞り込み条件を CSV エクスポートに引き継ぐ)
      const exportUrl = `/api/tickets/export?${searchParams.toString()}`;
      // fetch で CSV データを取得する (auth cookie はブラウザが自動付与する)
      const res = await fetch(exportUrl);
      // エラーレスポンスの場合は例外を投げる。
      // HTTP ステータスコードは内部情報のため alert に表示しない。
      // サーバーログの追跡には X-Request-ID 等を使い、ユーザーには汎用メッセージを見せる (§9)。
      if (!res.ok) {
        // レート制限 (429) やサーバーエラー (5xx) のケースを区別したメッセージをコンソールに記録する
        console.error(`[CsvExportButton] HTTP エラー: ${res.status}`);
        // alert には汎用メッセージのみ表示しステータスコードを漏洩させない。
        // 401 はセッション切れを意味するため「再ログインを促す」メッセージを返す。
        // 429 はレート制限なので「しばらく待つよう促す」メッセージを返す。
        // それ以外のエラー (5xx 等) は汎用メッセージを返す。
        throw new Error(
          res.status === 401
            ? 'セッションが切れました。ページを再読み込みしてからログインし直してください。'
            : res.status === 429
              ? 'しばらくしてから再度お試しください（エクスポートの上限に達しました）。'
              : 'CSV エクスポートに失敗しました。しばらくしてから再度お試しください。',
        );
      }
      // サーバーが MAX_EXPORT_ROWS でレスポンスを打ち切った場合に X-Truncated: true を返す。
      // headers はボディ消費後も参照可能だが、意図を明確にするためボディ取得前に読み取る。
      const truncated = res.headers.get('X-Truncated') === 'true';
      // 上限件数をレスポンスヘッダーから取得し、数値として検証する。
      // ヘッダー値を直接 alert に埋め込むと MitM でテキスト偽装が可能になるため (§9 情報漏洩対策)、
      // 整数以外の値は信頼せず既定値にフォールバックする。
      const rawLimit = res.headers.get('X-Total-Limit');
      const limitNum = rawLimit ? parseInt(rawLimit, 10) : NaN;
      // 数値でない場合はフォールバック値を使い、意図しない文字列が alert に表示されないようにする
      const totalLimit = Number.isFinite(limitNum) ? limitNum.toLocaleString('ja-JP') : '10,000';
      // レスポンスを Blob として取得する
      const blob = await res.blob();
      // ファイル名はサーバーの Content-Disposition ヘッダーから取得するのが理想だが、
      // クロスオリジン制限があるためクライアント側でも日付付きファイル名を設定する
      triggerBlobDownload(blob, `tickets-${new Date().toISOString().slice(0, 10)}.csv`);
      // エクスポートが上限件数で打ち切られていた場合はユーザーに警告を表示する。
      // ダウンロード完了後に通知することで、データ不足に気づかないままレポートを作る事故を防ぐ。
      if (truncated) {
        alert(
          `チケット数が上限 (${totalLimit} 件) を超えているため、CSV には最初の ${totalLimit} 件のみ含まれています。絞り込み条件を変更して再度エクスポートしてください。`,
        );
      }
    } catch (err) {
      // ブラウザのデベロッパーツールでエラー詳細を確認できるようにする (エラーを握り潰さない: CLAUDE.md §6)
      console.error('[CsvExportButton] CSV エクスポートに失敗:', err);
      // ユーザーには安全なメッセージのみ表示する (スタックトレース等の内部詳細は漏らさない: §9)。
      // TypeError はオフラインやネットワーク切断で fetch() が失敗したケース。
      // ブラウザが生成する英語メッセージ ("Failed to fetch" 等) は日本語 UI に表示しない。
      // throw new Error(...) で作成した制御済みメッセージ (HTTP エラー・429 等) は instanceof TypeError にならないため
      // そのまま err.message を使う。TypeError のみ日本語の接続エラーメッセージに差し替える。
      const message =
        err instanceof TypeError
          ? 'ネットワークエラーが発生しました。接続を確認してから再度お試しください。'
          : err instanceof Error
            ? err.message
            : 'CSV エクスポートに失敗しました。再度お試しください。';
      alert(message);
    } finally {
      // 成功・失敗どちらでもローディング状態を解除する
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleDownload}
      // ダウンロード中は再クリックを防ぐ
      disabled={loading}
      className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
      aria-label="現在の絞り込み条件でチケット一覧を CSV 形式でダウンロードする"
    >
      {/* ローディング中はスピナー文字を表示し、待機中であることを明示する */}
      {loading ? '取得中…' : 'CSV エクスポート'}
    </button>
  );
}
