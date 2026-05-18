// 添付ファイルに関する純ドメイン定数とドメイン型をまとめたモジュール。
// UI 層・Server Action 層・データ層から共有して同じ閾値・メッセージを使うための単一の真実源。

// 添付として受け付ける MIME 種別 (画像のみ。PDF などは現段階では対象外)
// docs/smb-dx-pivot-plan.md Phase 1 で「スマホで撮った写真を添付」がスコープのため画像に限定する
export const ALLOWED_IMAGE_MIME_TYPES = [
  'image/jpeg', // JPEG (スマホカメラの既定形式)
  'image/png', // PNG (スクリーンショット用)
  'image/webp', // WebP (Android 系で増えている軽量形式)
  'image/heic', // HEIC (iPhone カメラの既定形式)
] as const;

// 上のリテラル tuple から union 型を導出する (型レベルで MIME を厳格化するため)
export type AllowedImageMimeType = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

// 1 ファイル当たりの最大バイト数 (10MB = 10 * 1024 * 1024)
// スマホ写真は概ね 3〜6MB 程度のため余裕を持って 10MB に設定する
export const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;

// 1 回のアップロード (チケット作成 or コメント投稿) で添付できる最大件数
// 現場の追加写真は概ね 1〜3 枚で済む想定だが余裕を持って 5 枚まで許可する
export const MAX_ATTACHMENTS_PER_UPLOAD = 5;

// MIME に対応する一般的な拡張子の対応表 (保存先キー組み立てや配信時の Content-Disposition で利用)
export const MIME_TO_EXTENSION: Record<AllowedImageMimeType, string> = {
  'image/jpeg': 'jpg', // JPEG は .jpg を採用 (.jpeg ではなく短い方)
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

// 指定された MIME がアプリで受け入れる画像 MIME のいずれかかを判定する型ガード
export function isAllowedImageMimeType(mime: string): mime is AllowedImageMimeType {
  // 配列キャストして includes で判定 (readonly tuple のため string 配列に変換)
  return (ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(mime);
}

// 添付ファイル 1 件分のドメイン表現 (画面表示・API 配信で使う最小情報)
export interface Attachment {
  id: string; // 添付 ID (主キー)
  ticketId: string; // 親チケット ID (必須)
  commentId: string | null; // 紐づくコメント ID (チケット本体への直接添付は null)
  uploaderId: string; // アップロード実行者
  tenantId: string; // 所属テナント (where に必ず注入する)
  mimeType: string; // 検証通過後の MIME (image/jpeg など)
  size: number; // バイト数
  originalName: string; // 元ファイル名 (表示・ダウンロード時のヒント)
  storageKey: string; // 保存先キー (例: tenantId/ticketId/<uuid>.jpg)
  storage: AttachmentStorageKind; // 保存方式 (現状 local 固定)
  createdAt: Date; // 添付日時
}

// 添付の保存先種別 (Prisma enum と 1:1)。Phase 2 以降で s3 を実装する
export type AttachmentStorageKind = 'local' | 's3';
