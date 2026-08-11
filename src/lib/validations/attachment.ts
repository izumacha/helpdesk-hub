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

// 添付の「安価に判定できる違反」に対する利用者向け文言。**サーバー検証とフォームの事前検査が
// 同じ文字列を使う**ための単一の参照元 (§6 UI 文言は単一の参照元に集約する)。
// 直書きすると、フォーム側だけ推敲されて同じ違反にサーバーと別の案内が出る。
export const EMPTY_ATTACHMENT_MESSAGE = '空のファイルは添付できません';
export const ATTACHMENT_TOO_LARGE_MESSAGE = `1 ファイルあたり ${formatMb(MAX_ATTACHMENT_SIZE_BYTES)}MB までです`;
export const TOO_MANY_ATTACHMENTS_MESSAGE = `添付ファイルは最大 ${MAX_ATTACHMENTS_PER_UPLOAD} 件までです`;

/**
 * FormData の `files` エントリから「実際に選ばれた添付」だけを取り出す。
 *
 * **未選択の file input が混ぜてくる番兵 (sentinel) を落とすのが目的。** HTML の仕様上、
 * ファイルを 1 つも選んでいない `<input type="file">` もフォームにエントリを 1 件足す。
 * その中身は実行環境で姿が違う:
 *   - ブラウザ (`new FormData(form)`) … `File` (name: '', size: 0, type: 'application/octet-stream')
 *   - サーバー (undici が multipart を解析) … `filename=""` のパートは `File` ではなく空文字列
 * サーバー側は「`File` でないものを捨てる」だけで番兵が落ちるが、**ブラウザ側は本物の `File` なので
 * 同じ条件では落ちない**。両方で同じ結果にするため、`File` かどうかに加えて
 * 「名前が空で中身も空」という番兵の形も落とす。
 *
 * 名前のある 0 バイトファイル (利用者が空のファイルを選んだ場合) は番兵ではないので残し、
 * 「空のファイルは添付できません」で弾かれるようにする。
 *
 * @param entries `form.getAll('files')` の戻り値
 * @returns 実際に選ばれた File だけの配列 (未選択なら空配列)
 */
export function selectAttachmentFiles(entries: FormDataEntryValue[]): File[] {
  return entries.filter(
    (entry): entry is File =>
      // 文字列エントリ (サーバー側の番兵・想定外の値) は添付ではない
      entry instanceof File &&
      // ブラウザ側の番兵 (名前が空 かつ 中身も空) は「未選択」なので添付として数えない
      !(entry.name === '' && entry.size === 0),
  );
}

/**
 * 送信前にブラウザ側で判定できる添付の違反 (件数・空ファイル・1 件あたりのサイズ) を探す。
 * 違反が見つかれば利用者向けの文言を、無ければ null を返す。
 *
 * **なぜフォーム側にも検査が要るのか**: 合計サイズが `ATTACHMENT_UPLOAD_MAX_BODY_BYTES`
 * (件数上限 × 1 件あたりの上限 + 余裕枠) を超えると、サーバーは Content-Length の申告だけで
 * 判断して**本文を 1 バイトも読まずに 413 を返す** (`request-body-limit.ts`)。このとき送信途中の
 * 接続が未消費のまま閉じるため、ブラウザが応答より先に接続断を観測して fetch が reject し、
 * 画面には「通信状態をご確認ください」という的外れな案内しか出せない
 * (本来出したいのは「1 ファイルあたり 10.0MB までです」)。
 * 件数 5 × 1 件 10MB = 50MB は枠 51MB の内側なので、**ここで弾いておけば正規の入力が
 * 413 に到達することはなくなり**、違反したときは具体的な理由が画面に出る。
 *
 * **これは体験のための先回りであって、検証の本体ではない。** クライアントの検査は改ざんできるため、
 * 件数・サイズ・MIME・マジックバイトの判定は従来どおりサーバー側の `validateUploadedFiles` が
 * 権威を持つ (§9 認可・検証はサーバー側で強制する)。ここで MIME やマジックバイトまで見ないのは、
 * 中身の検査が非同期で重く、かつサーバーが必ずやり直すぶん先回りする利益が薄いため。
 *
 * @param files フォームで選択された File の一覧 (添付なしは空配列)
 * @returns 違反があればその文言、無ければ null
 */
export function findAttachmentPreflightError(files: File[]): string | null {
  // 添付なしは常に許可 (添付は任意のため)
  if (files.length === 0) return null;
  // 件数上限を超えていたら、その時点で確定なので先に返す
  if (files.length > MAX_ATTACHMENTS_PER_UPLOAD) return TOO_MANY_ATTACHMENTS_MESSAGE;
  // 1 件ずつ、サーバー側と同じ順序 (空 → サイズ) で安価な検査だけ当てる
  for (const file of files) {
    // 空ファイル (フォームから誤って送られたケース) を弾く
    if (file.size === 0) return EMPTY_ATTACHMENT_MESSAGE;
    // 1 件あたりのサイズ上限を超えるファイルを弾く
    if (file.size > MAX_ATTACHMENT_SIZE_BYTES) return ATTACHMENT_TOO_LARGE_MESSAGE;
  }
  // 安価な検査はすべて通過 (MIME・マジックバイトはサーバー側が見る)
  return null;
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
  // 文言はフォームの事前検査と共有する (同じ違反に別の案内を出さないため)
  if (file.size === 0) {
    return { ok: false, message: EMPTY_ATTACHMENT_MESSAGE };
  }
  // サイズ上限を超えるファイルは弾く (文言はフォームの事前検査と共有)
  if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
    return { ok: false, message: ATTACHMENT_TOO_LARGE_MESSAGE };
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
  // 件数上限を超える場合は明確なメッセージで弾く (文言はフォームの事前検査と共有)
  if (files.length > MAX_ATTACHMENTS_PER_UPLOAD) {
    return { ok: false, message: TOO_MANY_ATTACHMENTS_MESSAGE };
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
