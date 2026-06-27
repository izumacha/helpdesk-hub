'use client';

// URL クエリパラメータを読み取る (Suspense 境界が必要)
import { useSearchParams } from 'next/navigation';
// ローディング状態を管理する
import { useState } from 'react';

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
      // エラーレスポンスの場合は例外を投げる
      if (!res.ok) {
        throw new Error(`エクスポートに失敗しました (HTTP ${res.status})`);
      }
      // レスポンスを Blob として取得する
      const blob = await res.blob();
      // Blob から一時 URL を生成してダウンロードを開始する
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      // ファイル名はサーバーの Content-Disposition ヘッダーから取得するのが理想だが、
      // クロスオリジン制限があるためクライアント側でも日付付きファイル名を設定する
      link.download = `tickets-${new Date().toISOString().slice(0, 10)}.csv`;
      // DOM に一時追加してクリックしてダウンロードを起動し、すぐに削除する
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      // 一時 URL を解放してメモリリークを防ぐ
      URL.revokeObjectURL(url);
    } catch (err) {
      // エラーメッセージをユーザーに表示する (詳細は内部ログに留める)
      // スタックトレースは漏らさない (§9 セキュリティ)
      const message =
        err instanceof Error ? err.message : 'CSV エクスポートに失敗しました。再度お試しください。';
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
