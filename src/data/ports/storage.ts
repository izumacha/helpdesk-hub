// 添付ファイル本体の保存先抽象 (Port)。
// Phase 1 ではローカルボリューム実装のみ。Phase 2 以降で S3 互換実装に差し替える前提のため
// 入出力は Node の Buffer / Uint8Array に統一する。

// ストレージに書き込むときに付与するメタ情報 (検証通過済みの値だけを渡す)
export interface StoragePutMeta {
  contentType: string; // 既に許可 MIME であることが確認済みのコンテンツタイプ
  size: number; // バイト数 (検証で上限以下が確認済み)
}

// 添付ファイル本体の I/O を抽象化したリポジトリ契約
// - キー (storageKey) は呼び出し側で組み立てて渡す (例: tenantId/ticketId/uuid.ext)
//   呼び出し側は UUID を含めることで実用上のキー衝突を回避する
// - put は同名キーへの書き込みを **上書き** する。呼び出し側が UUID で一意性を担保している前提
// - 例外を投げる/投げないは実装に委ねず、呼び出し側がエラーを catch してロールバックする
export interface StoragePort {
  // 指定キーにバイト列を保存する。同名キーが既にある場合は上書きする
  put(key: string, data: Uint8Array, meta: StoragePutMeta): Promise<void>;
  // 指定キーのバイト列を読み出して返す。存在しなければ null
  get(key: string): Promise<Uint8Array | null>;
  // 指定キーのファイルを削除する。存在しなくてもエラーにしない (冪等)
  delete(key: string): Promise<void>;
}
