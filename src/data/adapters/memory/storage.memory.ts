// ストレージ Port のメモリ実装 (テスト用)。
// バイト列をプロセス内 Map にだけ保持し、ファイルシステムに触れない。

// Port 契約をインポート
import type { StoragePort, StoragePutMeta } from '@/data/ports/storage';

// メモリ実装で内部的に追跡するメタ情報 (検証用にテストから読み出せるよう保持しておく)
interface MemoryEntry {
  data: Uint8Array; // バイト列本体
  meta: StoragePutMeta; // 書き込み時のメタ (Content-Type / size)
}

// メモリストレージのファクトリ関数 + テスト用フック
export interface MemoryStoragePort extends StoragePort {
  // 現在保持している全エントリを直接覗ける (テスト検証用)
  readonly entries: Map<string, MemoryEntry>;
}

// メモリストレージを生成する関数 (各テストごとに呼んで独立な状態を作る)
export function createMemoryStorage(): MemoryStoragePort {
  // 内部状態: storageKey → エントリ
  const entries = new Map<string, MemoryEntry>();
  return {
    entries, // テストから直接覗けるよう公開する
    // 指定キーにバイト列を保存する (新規もしくは上書き)
    async put(key, data, meta) {
      // Map に格納する (本物の StoragePort と同じく成功なら resolve)
      entries.set(key, { data, meta });
    },
    // 指定キーのバイト列を返す (存在しなければ null)
    async get(key) {
      const entry = entries.get(key);
      return entry ? entry.data : null;
    },
    // 指定キーを削除する (存在しなくてもエラーにしない)
    async delete(key) {
      entries.delete(key);
    },
  };
}
