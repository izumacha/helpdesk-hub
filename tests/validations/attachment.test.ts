// 添付ファイル検証ヘルパーの単体テスト。
// サイズ / MIME / 件数の各エッジケースで日本語メッセージが正しく返ることを確認する。

// Vitest の DSL
import { describe, expect, it } from 'vitest';
// 検証対象
import { validateUploadedFiles } from '@/lib/validations/attachment';
// ドメイン定数 (上限値の参照用)
import {
  MAX_ATTACHMENT_SIZE_BYTES,
  MAX_ATTACHMENTS_PER_UPLOAD,
} from '@/domain/attachment';

// 指定サイズ・MIME・ファイル名で File を作るヘルパー
function makeFile(opts: { size: number; type: string; name?: string }): File {
  // 指定バイト数の Uint8Array を 1 つの Blob として包む
  const data = new Uint8Array(opts.size);
  // File は Blob を継承するため、type と name を指定して生成する
  return new File([data], opts.name ?? 'photo.jpg', { type: opts.type });
}

describe('validateUploadedFiles', () => {
  // 添付ゼロ件は成功 (任意項目のため)
  it('returns ok with empty array when no files are given', () => {
    const result = validateUploadedFiles([]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.files).toEqual([]);
  });

  // 許可された MIME / サイズなら成功
  it('accepts allowed image MIME types within size limit', () => {
    const file = makeFile({ size: 100_000, type: 'image/jpeg', name: 'photo.jpg' });
    const result = validateUploadedFiles([file]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.files).toHaveLength(1);
      expect(result.files[0].mimeType).toBe('image/jpeg');
      expect(result.files[0].size).toBe(100_000);
      expect(result.files[0].originalName).toBe('photo.jpg');
    }
  });

  // 件数上限を超えると日本語メッセージで失敗
  it('rejects when file count exceeds the per-upload limit', () => {
    const files = Array.from({ length: MAX_ATTACHMENTS_PER_UPLOAD + 1 }, () =>
      makeFile({ size: 1, type: 'image/jpeg' }),
    );
    const result = validateUploadedFiles(files);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/最大/);
  });

  // 1 ファイルがサイズ上限を超えると失敗
  it('rejects when a single file exceeds the size limit', () => {
    const file = makeFile({ size: MAX_ATTACHMENT_SIZE_BYTES + 1, type: 'image/jpeg' });
    const result = validateUploadedFiles([file]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/MB/);
  });

  // 禁止 MIME (PDF など) は失敗
  it('rejects disallowed MIME types', () => {
    const file = makeFile({ size: 100, type: 'application/pdf', name: 'doc.pdf' });
    const result = validateUploadedFiles([file]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/この形式のファイル/);
  });

  // 空ファイル (0 バイト) は失敗
  it('rejects empty files', () => {
    const file = makeFile({ size: 0, type: 'image/jpeg' });
    const result = validateUploadedFiles([file]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/空のファイル/);
  });

  // 元ファイル名が空文字なら "image" にフォールバックされる
  it('falls back to "image" when original filename is blank', () => {
    const file = makeFile({ size: 100, type: 'image/png', name: '   ' });
    const result = validateUploadedFiles([file]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.files[0].originalName).toBe('image');
  });
});
