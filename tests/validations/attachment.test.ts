// 添付ファイル検証ヘルパーの単体テスト。
// サイズ / MIME / 件数 / マジックバイト の各エッジケースで日本語メッセージが正しく返ることを確認する。

// Vitest の DSL
import { describe, expect, it } from 'vitest';
// 検証対象
import {
  ATTACHMENT_TOO_LARGE_MESSAGE,
  EMPTY_ATTACHMENT_MESSAGE,
  TOO_MANY_ATTACHMENTS_MESSAGE,
  findAttachmentPreflightError,
  selectAttachmentFiles,
  validateUploadedFiles,
} from '@/lib/validations/attachment';
// ドメイン定数 (上限値の参照用)
import { MAX_ATTACHMENT_SIZE_BYTES, MAX_ATTACHMENTS_PER_UPLOAD } from '@/domain/attachment';

// 既知のマジックバイト (各画像形式のシグネチャ)
const JPEG_MAGIC = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// WebP: "RIFF" + 4 バイトサイズ + "WEBP"
const WEBP_MAGIC = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
// HEIC: 4 バイト box size (任意) + "ftyp" + "heic"
const HEIC_MAGIC = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
]);

// 指定マジックバイト + パディングで File を組み立てる。size は最終バイト数を指定。
// type が undefined / 空のとき File.type は空文字になるため、デフォルト 'image/jpeg' を入れる
function makeFile(opts: {
  size: number;
  type: string;
  name?: string;
  magic?: Uint8Array; // 任意: 先頭に置くマジックバイト (なら type と整合する画像として通る)
}): File {
  // 最終バイト数のバッファを準備
  const data = new Uint8Array(opts.size);
  // マジックバイトを先頭にコピーする (残りは 0 埋め)
  if (opts.magic) data.set(opts.magic.slice(0, opts.size), 0);
  return new File([data], opts.name ?? 'photo.jpg', { type: opts.type });
}

describe('validateUploadedFiles', () => {
  // 添付ゼロ件は成功 (任意項目のため)
  it('returns ok with empty array when no files are given', async () => {
    const result = await validateUploadedFiles([]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.files).toEqual([]);
  });

  // 許可された MIME / サイズ + 正しいマジックバイトなら成功
  it('accepts allowed image MIME types with matching magic bytes', async () => {
    const file = makeFile({
      size: 100_000,
      type: 'image/jpeg',
      name: 'photo.jpg',
      magic: JPEG_MAGIC,
    });
    const result = await validateUploadedFiles([file]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.files).toHaveLength(1);
      expect(result.files[0].mimeType).toBe('image/jpeg');
      expect(result.files[0].size).toBe(100_000);
      expect(result.files[0].originalName).toBe('photo.jpg');
    }
  });

  // PNG / WebP / HEIC のマジックバイトも受け付ける
  it('accepts PNG / WebP / HEIC magic bytes', async () => {
    const files = [
      makeFile({ size: 1024, type: 'image/png', name: 'a.png', magic: PNG_MAGIC }),
      makeFile({ size: 1024, type: 'image/webp', name: 'a.webp', magic: WEBP_MAGIC }),
      makeFile({ size: 1024, type: 'image/heic', name: 'a.heic', magic: HEIC_MAGIC }),
    ];
    const result = await validateUploadedFiles(files);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.files).toHaveLength(3);
  });

  // 件数上限を超えると日本語メッセージで失敗
  it('rejects when file count exceeds the per-upload limit', async () => {
    const files = Array.from({ length: MAX_ATTACHMENTS_PER_UPLOAD + 1 }, () =>
      makeFile({ size: 16, type: 'image/jpeg', magic: JPEG_MAGIC }),
    );
    const result = await validateUploadedFiles(files);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/最大/);
  });

  // 1 ファイルがサイズ上限を超えると失敗
  it('rejects when a single file exceeds the size limit', async () => {
    const file = makeFile({
      size: MAX_ATTACHMENT_SIZE_BYTES + 1,
      type: 'image/jpeg',
      magic: JPEG_MAGIC,
    });
    const result = await validateUploadedFiles([file]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/MB/);
  });

  // 禁止 MIME (PDF など) は失敗
  it('rejects disallowed MIME types', async () => {
    const file = makeFile({ size: 100, type: 'application/pdf', name: 'doc.pdf' });
    const result = await validateUploadedFiles([file]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/この形式のファイル/);
  });

  // 空ファイル (0 バイト) は失敗
  it('rejects empty files', async () => {
    const file = makeFile({ size: 0, type: 'image/jpeg' });
    const result = await validateUploadedFiles([file]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/空のファイル/);
  });

  // 元ファイル名が空文字なら "image" にフォールバックされる
  it('falls back to "image" when original filename is blank', async () => {
    const file = makeFile({ size: 100, type: 'image/png', name: '   ', magic: PNG_MAGIC });
    const result = await validateUploadedFiles([file]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.files[0].originalName).toBe('image');
  });

  // マジックバイト偽装: 申告 image/jpeg だが中身がランダムバイト → 拒否
  it('rejects when declared MIME does not match magic bytes (spoofed type)', async () => {
    // ランダム (実際は 0 埋め) なバイト列を image/jpeg と申告
    const file = makeFile({ size: 1024, type: 'image/jpeg', name: 'spoof.jpg' });
    const result = await validateUploadedFiles([file]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/画像として認識できません/);
  });

  // 申告 image/png だが中身は JPEG マジック → 拒否 (拡張子偽装の典型)
  it('rejects when magic bytes belong to a different image format', async () => {
    const file = makeFile({ size: 1024, type: 'image/png', name: 'pretend.png', magic: JPEG_MAGIC });
    const result = await validateUploadedFiles([file]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/画像として認識できません/);
  });
});

// 未選択の file input が混ぜてくる番兵を落とす selectAttachmentFiles の検証。
// **ブラウザの実挙動を写し取ったテスト**: Chromium で `new FormData(form)` を実行すると、
// ファイル未選択の <input type="file"> は File (name: '', size: 0, type: 'application/octet-stream')
// を 1 件足す (サーバー側で undici が multipart を解析した場合は空文字列になる)。
// ここが落ちないと、添付なしのコメントが毎回「空のファイルは添付できません」で止まる。
describe('selectAttachmentFiles', () => {
  // ブラウザの番兵 (名前も中身も空の File) は添付として数えない
  it('drops the empty-file sentinel a browser appends for an unselected file input', () => {
    const sentinel = new File([], '', { type: 'application/octet-stream' });
    expect(selectAttachmentFiles([sentinel])).toEqual([]);
  });

  // サーバー側の番兵 (空文字列) も添付として数えない
  it('drops the empty-string sentinel undici produces server-side', () => {
    expect(selectAttachmentFiles([''])).toEqual([]);
  });

  // 名前のある 0 バイトファイルは番兵ではないので残す (「空のファイル」として弾かせるため)
  it('keeps a named zero-byte file so the empty-file rule can reject it', () => {
    const named = makeFile({ size: 0, type: 'image/png', name: 'empty.png' });
    expect(selectAttachmentFiles([named])).toHaveLength(1);
  });

  // 実ファイルと番兵が混在しても、実ファイルだけが残る
  it('keeps real files while dropping a sentinel mixed in', () => {
    const real = makeFile({ size: 100, type: 'image/png', name: 'a.png', magic: PNG_MAGIC });
    const sentinel = new File([], '', { type: 'application/octet-stream' });
    expect(selectAttachmentFiles([sentinel, real]).map((f) => f.name)).toEqual(['a.png']);
  });
});

// 送信前の事前検査。サーバー検証と同じ文言を返すことを表明する
// (フォームだけ推敲されて同じ違反に別の案内が出る退行を検出するため)。
describe('findAttachmentPreflightError', () => {
  // 添付なしは常に通す
  it('returns null when no files are selected', () => {
    expect(findAttachmentPreflightError([])).toBeNull();
  });

  // 件数上限ちょうどは通す (境界値)
  it('returns null at exactly the attachment count limit', () => {
    const files = Array.from({ length: MAX_ATTACHMENTS_PER_UPLOAD }, (_, i) =>
      makeFile({ size: 100, type: 'image/png', name: `a${i}.png`, magic: PNG_MAGIC }),
    );
    expect(findAttachmentPreflightError(files)).toBeNull();
  });

  // 件数上限 + 1 は件数の文言で弾く
  it('rejects one file over the count limit with the shared message', () => {
    const files = Array.from({ length: MAX_ATTACHMENTS_PER_UPLOAD + 1 }, (_, i) =>
      makeFile({ size: 100, type: 'image/png', name: `a${i}.png`, magic: PNG_MAGIC }),
    );
    expect(findAttachmentPreflightError(files)).toBe(TOO_MANY_ATTACHMENTS_MESSAGE);
  });

  // 1 件あたりのサイズ上限ちょうどは通す (境界値)
  it('returns null at exactly the per-file size limit', () => {
    const file = makeFile({
      size: MAX_ATTACHMENT_SIZE_BYTES,
      type: 'image/png',
      name: 'big.png',
      magic: PNG_MAGIC,
    });
    expect(findAttachmentPreflightError([file])).toBeNull();
  });

  // サイズ上限 + 1 バイトはサイズの文言で弾く
  it('rejects one byte over the per-file size limit with the shared message', () => {
    const file = makeFile({
      size: MAX_ATTACHMENT_SIZE_BYTES + 1,
      type: 'image/png',
      name: 'big.png',
      magic: PNG_MAGIC,
    });
    expect(findAttachmentPreflightError([file])).toBe(ATTACHMENT_TOO_LARGE_MESSAGE);
  });

  // 空ファイルは空ファイルの文言で弾く
  it('rejects a named empty file with the shared message', () => {
    const file = makeFile({ size: 0, type: 'image/png', name: 'empty.png' });
    expect(findAttachmentPreflightError([file])).toBe(EMPTY_ATTACHMENT_MESSAGE);
  });

  // **サーバー検証と同じ文言であること** — 片方だけ推敲されると案内がぶれるので機械的に固定する
  it('uses the same wording the server-side validation returns', async () => {
    const tooMany = Array.from({ length: MAX_ATTACHMENTS_PER_UPLOAD + 1 }, (_, i) =>
      makeFile({ size: 100, type: 'image/png', name: `a${i}.png`, magic: PNG_MAGIC }),
    );
    const serverCount = await validateUploadedFiles(tooMany);
    expect(serverCount.ok).toBe(false);
    if (!serverCount.ok) {
      expect(serverCount.message).toBe(findAttachmentPreflightError(tooMany));
    }

    const tooBig = [
      makeFile({
        size: MAX_ATTACHMENT_SIZE_BYTES + 1,
        type: 'image/png',
        name: 'big.png',
        magic: PNG_MAGIC,
      }),
    ];
    const serverSize = await validateUploadedFiles(tooBig);
    expect(serverSize.ok).toBe(false);
    if (!serverSize.ok) {
      expect(serverSize.message).toBe(findAttachmentPreflightError(tooBig));
    }
  });
});
