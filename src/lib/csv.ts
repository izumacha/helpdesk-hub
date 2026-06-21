/**
 * RFC 4180 準拠の CSV ユーティリティ
 *
 * サーバーアクション (import-tickets.ts) とクライアント UI (CsvImportForm.tsx) の
 * 両方から使えるように、純粋関数として分離したモジュール。
 * 'use server' / 'use client' を付けないことで双方向にインポート可能にする。
 */

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
      } else if (ch === ',') {
        // カンマ → フィールド終端。前後の空白を除いてリストに追加する
        fields.push(current.trim());
        // バッファをリセットして次のフィールドへ
        current = '';
      } else {
        // 通常文字 (フィールド途中の `"` も含む) をバッファに追加する
        current += ch;
      }
    }
  }
  // 最後のフィールドを追加する (末尾のカンマがなくても確実に取り込む)
  fields.push(current.trim());
  // 解析済みフィールド配列を返す
  return fields;
}
