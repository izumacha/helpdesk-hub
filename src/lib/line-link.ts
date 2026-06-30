/**
 * LINE メンバー紐付け用ワンタイムコードのヘルパー (Phase 2 β 解消 / docs/smb-dx-pivot-plan.md §4 Phase 2)。
 *
 * メンバーが Web 設定画面でコードを発行 → LINE 公式アカウントにそのコードを送信 → Webhook 側で照合し、
 * 送信元 LINE ユーザー ID をそのメンバーへ紐付ける。生コードは発行直後に画面で 1 度だけ表示し、
 * DB には SHA-256 ハッシュのみ保存する (マジックリンク / 招待と同方式)。
 *
 * コードは「LINE のトーク画面に手入力 / 貼り付けする」前提なので、長すぎず・紛らわしくない文字種にする。
 */

// 生コードのハッシュ化はマジックリンクと共通の SHA-256 実装を再利用する (Web Crypto)
export { hashMagicLinkToken as hashLineLinkCode } from '@/lib/magic-link';

// LINE ユーザー ID の正規形式 ('U' + 32 桁 16 進数)。受信 Webhook (起票・紐付け) と
// 送信 Push (line-push.ts) の双方で同じ形式チェックに使うので 1 か所にまとめる (§6 DRY)。
export const LINE_USER_ID_PATTERN = /^U[0-9a-f]{32}$/;

// コードに使う文字種: Crockford Base32 (数字 + 大文字英字から紛らわしい I/L/O/U を除いた 32 文字)。
// 見間違い (0/O, 1/I/L 等) を避け、トーク画面で読み上げ・転記しやすくする。
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
// コードの文字数 (ハイフン等の区切りを除いた実体長)。32^8 ≈ 1.1e12 通りで、
// 10 分 TTL + 単回使用 + Webhook レート制限 (120/分) の下では総当たり困難。
export const LINE_LINK_CODE_LENGTH = 8;
// 発行したコードの有効期限 (10 分)。送信後すぐ照合される前提なので短くして窃取耐性を上げる
export const LINE_LINK_CODE_TTL_MS = 10 * 60 * 1000;

// ランダムな紐付けコードを 1 つ生成する。表示用に中央へハイフンを 1 つ入れて読みやすくする
// (例: "AB7K-9QF2")。照合時は normalizeLineLinkCode でハイフンを除いてから突き合わせる。
export function generateLineLinkCode(): string {
  // 暗号学的乱数で 1 文字ずつ選ぶためのバッファを用意する
  const buf = new Uint8Array(LINE_LINK_CODE_LENGTH);
  globalThis.crypto.getRandomValues(buf);
  // 各バイトを文字種の範囲に写像して 1 文字ずつ組み立てる
  let body = '';
  for (let i = 0; i < LINE_LINK_CODE_LENGTH; i++) {
    // バイト値を文字数で割った余りでアルファベットの 1 文字を選ぶ (わずかな偏りは実用上無視できる)
    body += CODE_ALPHABET[buf[i]! % CODE_ALPHABET.length];
  }
  // 中央 (4 文字目の後) にハイフンを入れて表示用に整形する
  const mid = Math.floor(LINE_LINK_CODE_LENGTH / 2);
  return `${body.slice(0, mid)}-${body.slice(mid)}`;
}

// 受信テキストを照合用に正規化する: 英数字以外 (ハイフン・空白・全角等) を除去し、大文字へ揃える。
// ユーザーがハイフン無し / 小文字 / 前後空白付きで送ってきても一致するようにする。
export function normalizeLineLinkCode(text: string): string {
  // 大文字化してから、A-Z と 0-9 以外をすべて取り除く
  return text.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// 正規化済みテキストが「紐付けコードの形をしているか」を判定する (DB 照合の前段フィルタ)。
// 通常の問い合わせ文をいちいちハッシュ化・DB 照合しないための軽量チェックで、
// 形が一致しても DB に発行行が無ければ単に invalid となり通常起票に進む (誤判定は無害)。
export function looksLikeLineLinkCode(normalized: string): boolean {
  // 長さが規定値で、かつ全文字がコード用アルファベットに含まれるときだけ候補とみなす
  if (normalized.length !== LINE_LINK_CODE_LENGTH) return false;
  for (const ch of normalized) {
    if (!CODE_ALPHABET.includes(ch)) return false;
  }
  return true;
}
