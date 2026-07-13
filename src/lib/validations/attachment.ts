// 添付ファイル (multipart/form-data の File[]) を Server Action / API Route の手前で検証するヘルパー。
// Zod ではなく単独の関数として実装している理由:
// - Web 標準の File オブジェクトは Zod のスキーマ宣言に向かず、結局 refine の塊になる
// - エラーメッセージを日本語で一発で返すには手続的に書く方が読みやすい
// 検証結果は { ok: false, message } で返し、API 側で 422 にマップする想定。

// ドメイン定数 (許可 MIME / サイズ上限 / 件数上限) を引き当てる
import {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_ATTACHMENT_SIZE_BYTES,
  MAX_ATTACHMENTS_PER_UPLOAD,
  isAllowedImageMimeType,
  type AllowedImageMimeType,
} from '@/domain/attachment';
// マジックバイトによる中身偽装検証 (申告 MIME と実バイト列の整合チェック)
import { MAGIC_BYTES_PEEK_LENGTH, verifyImageMagicBytes } from '@/domain/image-magic-bytes';

// 検証成功時の戻り値型 (受け取った File をそのまま返す)
export interface AttachmentValidationOk {
  ok: true; // 成功フラグ (型ナローイング用)
  files: ValidatedAttachment[]; // 検証通過したファイル一式
}

// 検証失敗時の戻り値型 (日本語メッセージ)
export interface AttachmentValidationError {
  ok: false; // 失敗フラグ
  message: string; // 日本語メッセージ (UI / 422 レスポンスにそのまま使える)
}

// 検証成功後の 1 ファイル分の整理済み情報
export interface ValidatedAttachment {
  file: File; // 元の File (バイト列読み出し用)
  mimeType: AllowedImageMimeType; // 検証通過後の MIME (絞り込み済み)
  size: number; // バイト数 (上限以下が確認済み)
  originalName: string; // 表示・ダウンロード時のヒント
}

// バイト数を MB に丸めて文字列化する (ユーザー向けエラーで使う)
function formatMb(bytes: number): string {
  // 小数第 1 位までに丸める (例: 10.0MB)
  return (bytes / (1024 * 1024)).toFixed(1);
}

// 1 ファイル分の検証本体 (件数チェックは呼び出し側の責務)。
// 申告 MIME (file.type) と サイズの安価な検査を先に通し、最後に先頭 16 バイトのマジックバイトを
// 実バイト列で確認する (中身偽装への防御)。validateUploadedFiles (全件一括・1 件でも違反があれば
// 全体を失敗させる) と validateUploadedFilesLenient (個々に検証し有効なものだけ残す) の両方が
// この関数を共有することで、検証ルールの定義を 1 か所に保つ (§6 DRY)。
async function validateSingleFile(
  file: File,
): Promise<{ ok: true; value: ValidatedAttachment } | { ok: false; message: string }> {
  // size === 0 のファイルは空ファイル (フォームから誤って送られたケース) として弾く
  if (file.size === 0) {
    return { ok: false, message: '空のファイルは添付できません' };
  }
  // サイズ上限を超えるファイルは弾く
  if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
    return {
      ok: false,
      message: `1 ファイルあたり ${formatMb(MAX_ATTACHMENT_SIZE_BYTES)}MB までです`,
    };
  }
  // MIME は許可リストにあるものだけ通す (申告ベース)
  if (!isAllowedImageMimeType(file.type)) {
    return {
      ok: false,
      message: `この形式のファイルは添付できません (許可: ${ALLOWED_IMAGE_MIME_TYPES.join(', ')})`,
    };
  }
  // 中身偽装防御: 先頭 16 バイトを読み、申告 MIME と実マジックバイトの整合を確認する
  // File.slice は同期、arrayBuffer は async だが既に in-memory のため実 I/O は発生しない
  const headBuffer = await file.slice(0, MAGIC_BYTES_PEEK_LENGTH).arrayBuffer();
  const headBytes = new Uint8Array(headBuffer);
  if (!verifyImageMagicBytes(file.type, headBytes)) {
    // 申告 MIME と中身が一致しないファイルは保存しない
    return { ok: false, message: 'ファイルの内容が画像として認識できません' };
  }
  // 元ファイル名は trim して空なら "image" にフォールバックする (UI 表示のため)
  const originalName = file.name.trim() || 'image';
  // 検証通過: 整理済み情報を返す
  return {
    ok: true,
    value: {
      file,
      mimeType: file.type as AllowedImageMimeType, // 直前の isAllowedImageMimeType で絞り込み済み
      size: file.size,
      originalName,
    },
  };
}

// アップロードされた File[] を検証する。1 ファイルでも違反があれば全体を失敗扱いにする。
// Web フォーム / コメント投稿のように、失敗時にユーザーへ即座にフィードバックして修正・再送信
// させられる UI 向け。
export async function validateUploadedFiles(
  files: File[],
): Promise<AttachmentValidationOk | AttachmentValidationError> {
  // 件数 0 (添付なし) は許可: 添付任意のため成功で空配列を返す
  if (files.length === 0) {
    return { ok: true, files: [] };
  }
  // 件数上限を超える場合は明確なメッセージで弾く
  if (files.length > MAX_ATTACHMENTS_PER_UPLOAD) {
    return {
      ok: false,
      message: `添付ファイルは最大 ${MAX_ATTACHMENTS_PER_UPLOAD} 件までです`,
    };
  }

  // 検証通過済みのバッファ
  const validated: ValidatedAttachment[] = [];
  // 各ファイルを順に検査する (1 件でも違反があればすぐ return)
  for (const file of files) {
    const result = await validateSingleFile(file);
    if (!result.ok) return { ok: false, message: result.message };
    validated.push(result.value);
  }

  // 全件通過: 整理済みリストを返す
  return { ok: true, files: validated };
}

// 寛容版検証の戻り値型 (常に成功。却下された件数だけログ用に返す)
export interface LenientAttachmentValidation {
  files: ValidatedAttachment[]; // 検証を通過した有効なファイルのみ
  droppedCount: number; // 却下された件数 (呼び出し側のログ用)
}

// /code-review ultra 指摘対応 (2026-07-13): メール取り込みのように、ユーザーへ即座に
// フィードバックして修正・再送信させられる画面が無い呼び出し元向けの寛容版。
// validateUploadedFiles と異なり 1 件でも違反があっても全体を失敗させず、有効なファイルだけを
// 残す (例: 3 枚の有効な写真 + 1 件の非対応形式ファイルが混在していた場合、写真 3 枚は
// 問い合わせに残したい。全件一括の validateUploadedFiles だとこの場合も全滅してしまう)。
// 件数上限を超える分は (どれを優先すべきか判断できないため) 先頭から上限件数だけを対象にし、
// 超過分は静かに切り捨てる (droppedCount に反映される)。
export async function validateUploadedFilesLenient(
  files: File[],
): Promise<LenientAttachmentValidation> {
  const capped = files.slice(0, MAX_ATTACHMENTS_PER_UPLOAD);
  const validated: ValidatedAttachment[] = [];
  for (const file of capped) {
    const result = await validateSingleFile(file);
    if (result.ok) validated.push(result.value);
  }
  return { files: validated, droppedCount: files.length - validated.length };
}
