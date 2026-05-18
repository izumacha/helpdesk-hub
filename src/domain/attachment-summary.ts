// 詳細画面のサムネイル表示で使う添付ファイルの最小情報。
// バイナリ本体や storageKey は公開しないため、Attachment から storage 系を除いた純粋な「表示用」サブセットとして定義する。
// 配信時には GET /api/attachments/[id] を経由するため、画面側は id だけ知っていれば十分。

export interface AttachmentSummary {
  id: string; // 添付 ID (配信 URL の /api/attachments/<id> で使う)
  mimeType: string; // MIME (img タグの alt 属性などのヒント)
  size: number; // バイト数 (将来のサイズ表示用)
  originalName: string; // 元ファイル名 (表示・ダウンロード時のヒント)
  createdAt: Date; // 添付日時 (将来的な並び替えに利用可能)
}
