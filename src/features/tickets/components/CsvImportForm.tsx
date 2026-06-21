'use client';

// CSV インポートフォーム (Phase 3 CSVインポート機能)
// ファイル選択 → プレビュー → インポート実行 → 結果表示 の UI を担当する Client Component

// 状態管理・非ブロッキング送信のためのフック
import { useState, useTransition } from 'react';
// CSV インポートのサーバーアクション
import { importTickets } from '@/features/tickets/actions/import-tickets';
// インポート結果の型 (成功件数 + エラー一覧)
import type { ImportTicketsResult } from '@/features/tickets/actions/import-tickets';

// CSV インポートフォームに渡す Props 型
// categories は将来のカテゴリ選択 UI 向けに受け取るが、MVP では使用しない
interface CsvImportFormProps {
  categories: Array<{ id: string; name: string }>; // カテゴリ一覧 (将来の列マッピング用)
}

// CSV のプレビュー行を表す型 (ヘッダ名 → 値のマップ)
interface PreviewRow {
  件名: string; // 件名セル
  内容: string; // 内容セル (省略可)
  期限日: string; // 期限日セル (省略可)
  優先度: string; // 優先度セル (省略可)
}

// CSV テキストから先頭 5 件のデータ行をプレビュー用に解析する純粋関数
function parsePreview(csvText: string): PreviewRow[] {
  // 改行コード (CRLF / LF どちらにも対応) で行に分割する
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim() !== '');
  // 行が 1 行 (ヘッダのみ) か 0 行の場合はプレビューなし
  if (lines.length < 2) return [];
  // ヘッダ行を取り出してカンマ分割する
  const headers = (lines[0] ?? '').split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  // データ行は最大 5 件に絞る (プレビューなので多すぎない量に制限)
  const dataLines = lines.slice(1, 6);
  // 各データ行を PreviewRow 型にマッピングして返す
  return dataLines.map((line) => {
    // 行をカンマ分割してセル配列を得る
    const cells = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    // ヘッダ名から対応するセルの値を取り出すヘルパー (見つからなければ空文字)
    const get = (name: string): string => {
      const idx = headers.indexOf(name); // ヘッダのインデックスを検索
      return idx !== -1 ? (cells[idx] ?? '') : ''; // 対応セルの値を返す
    };
    // PreviewRow 型に変換して返す
    return {
      件名: get('件名'), // 件名列の値
      内容: get('内容'), // 内容列の値
      期限日: get('期限日'), // 期限日列の値
      優先度: get('優先度'), // 優先度列の値
    };
  });
}

// CSV インポートフォームコンポーネント
export function CsvImportForm({ categories: _categories }: CsvImportFormProps) {
  // 読み込んだ CSV テキスト (null = ファイル未選択)
  const [csvText, setCsvText] = useState<string | null>(null);
  // プレビューテーブルに表示する先頭 5 行のデータ
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  // インポート実行結果 (null = 未実行)
  const [result, setResult] = useState<ImportTicketsResult | null>(null);
  // サーバーアクションのエラーメッセージ (throw された場合)
  const [error, setError] = useState<string | null>(null);
  // useTransition でインポート中フラグを管理する (ボタン無効化・スピナー表示に使う)
  const [isPending, startTransition] = useTransition();

  // ファイル選択時のハンドラ: File を読み込んで CSV テキストとプレビューを更新する
  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    // 選択されたファイルを取り出す (未選択なら undefined)
    const file = e.target.files?.[0];
    // ファイルが選択されていなければ状態をリセットして終了
    if (!file) {
      setCsvText(null); // CSV テキストをクリア
      setPreview([]); // プレビューをクリア
      setResult(null); // 結果をクリア
      setError(null); // エラーをクリア
      return;
    }
    // FileReader で CSV ファイルをテキストとして非同期読み込みする
    const reader = new FileReader();
    // 読み込み完了時のコールバック
    reader.onload = (ev) => {
      // 読み込んだテキストを文字列として取り出す
      const text = ev.target?.result;
      if (typeof text !== 'string') return; // 読み込み失敗時は何もしない
      // CSV テキストをステートに保存する
      setCsvText(text);
      // プレビューデータを解析してステートに保存する
      setPreview(parsePreview(text));
      // 前回の結果とエラーをクリアする (新しいファイルに切り替えたので)
      setResult(null);
      setError(null);
    };
    // UTF-8 テキストとして読み込む
    reader.readAsText(file, 'UTF-8');
  }

  // インポート実行ボタンのハンドラ
  function handleImport() {
    // CSV テキストが未設定の場合は何もしない (ボタンは disabled なので通常は発火しない)
    if (!csvText) return;
    // 前回の結果とエラーをクリアしてから実行する
    setResult(null);
    setError(null);
    // useTransition でバックグラウンド実行する (UI がフリーズしない)
    startTransition(async () => {
      try {
        // サーバーアクションを呼び出す
        const res = await importTickets(csvText);
        // 成功 (部分成功含む) の場合は結果を表示する
        setResult(res);
      } catch (err) {
        // サーバーアクションが throw した場合はエラーメッセージを表示する
        setError(err instanceof Error ? err.message : 'インポートに失敗しました');
      }
    });
  }

  return (
    <div className="space-y-6">
      {/* CSV の形式ヒント */}
      <div className="rounded-lg bg-slate-50 p-4 text-sm text-slate-600 ring-1 ring-slate-200">
        {/* ヒントのタイトル */}
        <p className="mb-1 font-semibold text-slate-700">CSV の形式</p>
        {/* 必須・任意の列名と説明 */}
        <p className="font-mono text-xs text-slate-500">件名（必須）, 内容, 期限日(YYYY-MM-DD), 優先度（高/中/低）</p>
        {/* 最大行数の説明 */}
        <p className="mt-1 text-xs text-slate-400">1 回のインポートは最大 200 行です。</p>
      </div>

      {/* ファイル選択 (CSV のみ許可) */}
      <div className="space-y-1">
        <label htmlFor="csvFile" className="block text-sm font-medium text-slate-700">
          CSV ファイルを選択
        </label>
        <input
          id="csvFile"
          type="file"
          accept=".csv"
          onChange={handleFileChange}
          className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-teal-50 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-teal-700 hover:file:bg-teal-100"
        />
      </div>

      {/* プレビューテーブル (先頭 5 行) */}
      {preview.length > 0 && (
        <div className="overflow-x-auto">
          {/* プレビューの件数表示 */}
          <p className="mb-2 text-sm text-slate-500">プレビュー（先頭 {preview.length} 件）</p>
          <table className="min-w-full divide-y divide-slate-100 rounded-xl bg-white text-sm ring-1 ring-slate-100">
            <thead className="bg-slate-50">
              <tr>
                {/* ヘッダセル: 件名 */}
                <th className="px-4 py-2 text-left text-xs font-semibold text-slate-500">件名</th>
                {/* ヘッダセル: 内容 (省略表示) */}
                <th className="px-4 py-2 text-left text-xs font-semibold text-slate-500">内容</th>
                {/* ヘッダセル: 期限日 */}
                <th className="px-4 py-2 text-left text-xs font-semibold text-slate-500">期限日</th>
                {/* ヘッダセル: 優先度 */}
                <th className="px-4 py-2 text-left text-xs font-semibold text-slate-500">優先度</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {preview.map((row: PreviewRow, idx: number) => (
                /* 各プレビュー行 */
                <tr key={idx}>
                  {/* 件名セル */}
                  <td className="px-4 py-2 text-slate-800">{row.件名}</td>
                  {/* 内容セル: 長い場合は 20 文字で切り詰める */}
                  <td className="px-4 py-2 text-slate-500">
                    {row.内容.length > 20 ? `${row.内容.slice(0, 20)}…` : row.内容}
                  </td>
                  {/* 期限日セル */}
                  <td className="px-4 py-2 text-slate-500">{row.期限日 || '―'}</td>
                  {/* 優先度セル */}
                  <td className="px-4 py-2 text-slate-500">{row.優先度 || '中'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* インポート実行ボタン (ファイル未選択 or 実行中は無効) */}
      <button
        type="button"
        onClick={handleImport}
        disabled={!csvText || isPending}
        className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {/* 実行中はスピナーテキストを表示する */}
        {isPending ? 'インポート中…' : 'インポート'}
      </button>

      {/* サーバーアクションの例外エラー表示 (色だけでなくテキストでも状態を伝える) */}
      {error && (
        <p className="text-sm text-rose-700" role="alert">
          {error}
        </p>
      )}

      {/* インポート結果表示 (成功件数 + エラー一覧) */}
      {result && (
        <div className="space-y-3" role="status" aria-live="polite">
          {/* 成功件数バナー */}
          <p className="text-sm font-medium text-teal-700">
            {result.imported} 件をインポートしました
            {/* エラーがある場合は合計件数も表示する */}
            {result.errors.length > 0 && `（${result.errors.length} 件のエラーあり）`}
          </p>
          {/* エラー一覧 (エラーがある場合のみ表示) */}
          {result.errors.length > 0 && (
            <ul className="space-y-1 rounded-lg bg-rose-50 p-4 ring-1 ring-rose-100">
              {result.errors.map((e: { row: number; message: string }) => (
                /* エラー 1 件: 行番号 + エラーメッセージ */
                <li key={e.row} className="text-sm text-rose-700">
                  {/* 行番号を強調表示する */}
                  <span className="font-medium">{e.row} 行目:</span> {e.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
