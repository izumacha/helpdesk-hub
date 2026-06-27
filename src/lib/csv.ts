/**
 * RFC 4180 準拠の CSV ユーティリティ
 *
 * サーバーアクション (import-tickets.ts) / エクスポート API (api/tickets/export) /
 * クライアント UI (CsvImportForm.tsx, AuditExportButton.tsx) の全方位から使えるよう、
 * 純粋関数として分離したモジュール。
 * 'use server' / 'use client' を付けないことで双方向にインポート可能にする。
 */

// CSV ファイルのサイズ上限 (512KB)。
// サーバーアクション (import-tickets.ts) とクライアント UI (CsvImportForm.tsx) が
// 同じ値を参照するようにここで一元管理する。一方だけ変えると挙動が乖離するため
// 必ずこの定数を import して使い、各所への直書きを避ける (§6 定数の一元管理)。
export const MAX_CSV_BYTES = 512 * 1024; // 512KB (バイト単位)

/**
 * RFC 4180 準拠の CSV 行パーサ。
 *
 * 引用符で囲まれたフィールド内のカンマを正しく扱う。
 * 例: `"PCトラブル, ネットワーク",高` → ['PCトラブル, ネットワーク', '高']
 *
 * RFC 4180 からの逸脱を lenient に処理:
 * - フィールド開始直後ではない位置の `"` はリテラル文字として扱う
 *   (例: `5" monitor` の `"` はインチ記号として保持する)
 * - これにより `5" monitor,高` が `['5" monitor', '高']` と正しく解析される
 */
export function parseCsvLine(line: string): string[] {
  // 解析結果を格納する配列
  const fields: string[] = [];
  // 現在のフィールド文字列を蓄積するバッファ
  let current = '';
  // フィールドが引用符で囲まれているかのフラグ
  let inQuotes = false;
  // 現在のフィールドが引用符で始まったかを記録するフラグ
  // RFC 4180 §2.7: 引用フィールドの空白は保持すべき値の一部。trim() してはいけない
  let wasQuoted = false;
  // 1 文字ずつ走査する
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]; // 現在の文字
    if (inQuotes) {
      if (ch === '"') {
        // 次の文字も '"' なら RFC 4180 のエスケープ ("" → ") として扱う
        if (line[i + 1] === '"') {
          current += '"'; // エスケープされた引用符をバッファに追加
          i += 1; // 次の '"' をスキップする
        } else {
          // 引用符の終了 → 引用モードを抜ける
          inQuotes = false;
        }
      } else {
        // 引用符内の通常文字はそのままバッファに追加する
        current += ch;
      }
    } else {
      if (ch === '"' && current === '') {
        // RFC 4180: 引用符はフィールド開始位置 (バッファが空) でのみ引用モードに入る。
        // バッファに文字が既にある場合 (例: `5"` の `"`) はリテラル文字として扱い、
        // 誤ってコンマを飲み込むクォートモードには入らない。
        inQuotes = true;
        // このフィールドは引用符付きであることを記録する (trim スキップのため)
        wasQuoted = true;
      } else if (ch === ',') {
        // カンマ → フィールド終端。
        // 引用フィールドは空白を保持する (RFC 4180 §2.7)。非引用フィールドのみ trim する。
        fields.push(wasQuoted ? current : current.trim());
        // バッファをリセットして次のフィールドへ
        current = '';
        // 次のフィールドのために wasQuoted をリセットする
        wasQuoted = false;
      } else {
        // 通常文字 (フィールド途中の `"` も含む) をバッファに追加する
        current += ch;
      }
    }
  }
  // ループ終了後に引用符が閉じられていない場合は不正な CSV 行としてエラーを投げる。
  // 閉じ忘れのまま放置すると後続のカンマがすべてフィールド内容として飲み込まれ、
  // 列ずれが起きてチケットに誤ったデータが取り込まれるため、サイレントスキップせず明示エラーにする。
  if (inQuotes) {
    throw new SyntaxError('CSV の引用符が閉じられていません。行を確認してください。');
  }
  // 最後のフィールドを追加する (末尾のカンマがなくても確実に取り込む)
  // 引用フィールドは空白を保持する (RFC 4180 §2.7)
  fields.push(wasQuoted ? current : current.trim());
  // 解析済みフィールド配列を返す
  return fields;
}

/**
 * CSV セルを安全にエスケープする関数。
 *
 * - ダブルクォート・カンマ・改行を含む値はダブルクォートで囲み、内部の `"` を `""` で 2 重化する。
 * - CSV インジェクション対策: `=`, `+`, `-`, `@` で始まる値の先頭にタブを挿入して
 *   スプレッドシートの数式解釈を無害化する (OWASP CSV Injection 対策)。
 * - null / undefined は空文字列として出力する。
 *
 * エクスポート API (api/tickets/export) と監査ログエクスポート (AuditExportButton)
 * の両方が同一ロジックを参照できるように、ここで一元管理する (§6 DRY 原則)。
 */
export function escapeCSVCell(value: string | null | undefined): string {
  // null/undefined は空文字列として出力する
  if (value == null) return '';
  // スプレッドシートが数式として解釈するプレフィックス (=, +, -, @) で始まる場合、
  // タブを先頭に付与して数式として評価されないようにする (OWASP CSV Injection 対策)
  const neutralised = /^[=+\-@]/.test(value) ? `\t${value}` : value;
  // 特殊文字 (カンマ・ダブルクォート・改行) が含まれる場合はダブルクォートで囲む
  // \r のみ (CR-only) の改行も Excel が行区切りとして解釈するため \n と同様に処理する
  // \t (タブ) は OWASP 対策として先頭に付与した場合、RFC 4180 の TEXTDATA 範囲外のため
  // 引用符で囲んで RFC 準拠にする
  if (
    neutralised.includes(',') ||
    neutralised.includes('"') ||
    neutralised.includes('\n') ||
    neutralised.includes('\r') ||
    neutralised.includes('\t')
  ) {
    return `"${neutralised.replace(/"/g, '""')}"`;
  }
  return neutralised;
}

/**
 * ヘッダー行とデータ行の 2 次元配列から BOM 付き UTF-8 の CSV 文字列を生成する。
 *
 * BOM (`﻿`) を先頭に付与することで Excel での文字化けを防ぐ。
 * 各行の末尾には CRLF ではなく LF を使う (Web サーバから配信する際の標準的な改行コード)。
 */
export function buildCsvString(headers: string[], rows: string[][]): string {
  // ヘッダー行をエスケープしてカンマで連結する
  const headerLine = headers.map(escapeCSVCell).join(',');
  // データ行を 1 行ずつエスケープしてカンマで連結する
  const dataLines = rows.map((row) => row.map(escapeCSVCell).join(','));
  // BOM + ヘッダー + データ行を LF で結合して返す
  return '﻿' + [headerLine, ...dataLines].join('\n');
}
