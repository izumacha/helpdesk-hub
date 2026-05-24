// 画像ファイルのマジックバイト (ファイル先頭の固定パターン) を確認するヘルパー。
// `file.type` (ブラウザ申告 MIME) は API 直叩きで偽装できるため、保存前に実バイト列も検証する。
// docs/smb-dx-pivot-plan.md の Phase 1 で「画像のみ」と決めているスキャナーを、
// 中身の偽装 (例: text/plain を image/jpeg と申告) にも耐える形で実装する。

// 受け付ける画像 MIME とそれぞれのマジックバイト判定関数の対応表
// 判定関数は十分なバイト列が読めている前提で呼ばれ、true なら「中身もその MIME」と確認できる
type SnifferEntry = {
  mime: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic';
  // バイト列が「その形式」と判断できれば true を返す関数
  check: (bytes: Uint8Array) => boolean;
};

// 各画像形式のマジックバイト判定 (バッファ長は呼び出し側が 16 バイト以上に揃える)
const SNIFFERS: SnifferEntry[] = [
  {
    // JPEG: 先頭 3 バイトが 0xFF 0xD8 0xFF
    mime: 'image/jpeg',
    check: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    // PNG: 先頭 8 バイトが固定シグネチャ "89 50 4E 47 0D 0A 1A 0A"
    mime: 'image/png',
    check: (b) =>
      b.length >= 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  },
  {
    // WebP: バイト 0-3 = "RIFF"、バイト 8-11 = "WEBP"
    mime: 'image/webp',
    check: (b) =>
      b.length >= 12 &&
      // "RIFF" の ASCII (0x52 0x49 0x46 0x46)
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      // "WEBP" の ASCII (0x57 0x45 0x42 0x50)
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
  },
  {
    // HEIC: ISO Base Media File Format。バイト 4-7 = "ftyp"、バイト 8-11 のブランドが HEIF 系
    // 受理ブランド: heic / heix / mif1 / msf1 / heim / heis / hevc / hevx
    mime: 'image/heic',
    check: (b) => {
      // 最低 12 バイト必要 (size:4 + "ftyp":4 + brand:4)
      if (b.length < 12) return false;
      // "ftyp" の ASCII (0x66 0x74 0x79 0x70)
      const isFtyp = b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70;
      if (!isFtyp) return false;
      // ブランド 4 文字を ASCII 文字列化して受理リストに含まれるかチェック
      const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
      // HEIF 系の代表的なブランドを許容 (heic 単体だけだと iPhone の一部画像を弾くため少し広めに取る)
      return ['heic', 'heix', 'mif1', 'msf1', 'heim', 'heis', 'hevc', 'hevx'].includes(brand);
    },
  },
];

// 申告 MIME と実バイト列を突き合わせる検証関数。
// 申告 MIME に対応するスニッファが「中身もその MIME」と判断したときだけ true を返す。
// ファイルが極端に短い・上のいずれの判定にも合致しないときは false。
export function verifyImageMagicBytes(declaredMime: string, bytes: Uint8Array): boolean {
  // 申告された MIME に対応するスニッファを探す
  const sniffer = SNIFFERS.find((s) => s.mime === declaredMime);
  // 対応するスニッファが無いなら検証不能 → false
  if (!sniffer) return false;
  // バイト列を判定関数に渡して結果を返す
  return sniffer.check(bytes);
}

// マジックバイト判定に必要な最低バイト数 (WebP / HEIC が 12 バイト必要)
// ファイル全体ではなく先頭 PEEK_BYTES バイトだけ読み出せば十分
export const MAGIC_BYTES_PEEK_LENGTH = 16;
