// ブラウザで Blob をファイルとしてダウンロードさせる共通処理 (クライアント専用。document/URL に依存)。
//
// /code-review ultra 指摘対応: CsvExportButton (tickets/export) / AuditExportButton (audit/page) /
// AuditFullExportButton (audit/export API) の 3 つのボタンが「Blob URL 生成 → <a> をクリック →
// 解放」という同じ手順をほぼ一字一句複製していた (CLAUDE.md §6 DRY: 2〜3 箇所目の重複で共通化する)。
// ここに集約し、3 ボタンともこの関数を呼ぶだけにする。

// Firefox では link.click() 直後に revokeObjectURL() を呼ぶとダウンロードがキャンセルされる
// ことがある。ブラウザがダウンロードを開始するまでの待機時間 (ミリ秒)。
const REVOKE_URL_DELAY_MS = 100;

/**
 * Blob を指定ファイル名でブラウザにダウンロードさせる。
 * DOM 操作に失敗した場合は URL を即座に解放してから例外を再送出する (呼び出し側で catch する前提)。
 */
export function triggerBlobDownload(blob: Blob, filename: string): void {
  // ブラウザにダウンロードさせるための一時 URL を生成する
  const url = URL.createObjectURL(blob);
  // DOM 操作前にタイマーを登録することで、DOM 操作で例外が発生しても URL が確実に解放される。
  // catch ブロックで clearTimeout + 即時 revokeObjectURL を呼ぶことで二重解放を防ぐ。
  const revokeTimer = setTimeout(() => URL.revokeObjectURL(url), REVOKE_URL_DELAY_MS);
  try {
    // <a> タグを動的に作成してクリックすることでダウンロードを開始する
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    // DOM に追加してクリックし、すぐに削除する (メモリ節約)
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } catch (domErr) {
    // DOM 操作に失敗した場合はタイマーをキャンセルして URL を即座に解放する
    clearTimeout(revokeTimer);
    URL.revokeObjectURL(url);
    // 呼び出し元の catch ブロックへ伝播させてユーザーに通知させる
    throw domErr;
  }
}
