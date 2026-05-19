// ストレージ Port のローカルボリューム実装。
// 保存先ルートは引数 (or process.env.UPLOAD_DIR) で受け取り、./var/uploads/<tenantId>/<ticketId>/<uuid>.<ext> を組み立てる。
// Phase 1 では単一インスタンス前提。複数インスタンス展開時は S3 互換実装に差し替えること。

// Node の fs/promises を非同期 I/O に使用する
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
// パス操作 (親ディレクトリ計算・絶対パス化・OS 区切り対応の相対化) に使用する
import { dirname, isAbsolute, relative, resolve } from 'node:path';
// Port 契約をインポート
import type { StoragePort } from '@/data/ports/storage';

// 渡されたキーが「ルート配下に閉じている」ことを保証するヘルパー
// "../" 等で外側に出ようとする攻撃的な key を拒否し、Path Traversal を防ぐ。
// OS 依存のパス区切り (POSIX の '/' / Windows の '\\') に依存しない判定にするため
// startsWith ではなく path.relative + .. 判定を使う
function resolveSafePath(rootAbs: string, key: string): string {
  // 候補となる絶対パスを計算する (resolve でセグメントを正規化)
  const candidate = resolve(rootAbs, key);
  // 候補をルートからの相対パスにする
  // - '..' を含む / 絶対パスのまま / 空文字 (= ルート自身) のいずれも拒否
  const rel = relative(rootAbs, candidate);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`storage key escapes root: ${key}`);
  }
  // 安全と分かった絶対パスを返す
  return candidate;
}

// ローカル FS ストレージのファクトリ関数 (root はテストで上書き可能にしておく)
export function createLocalStorage(root: string): StoragePort {
  // root を絶対パスに正規化しておく (相対パスは CWD 基準で解釈する)
  const rootAbs = isAbsolute(root) ? resolve(root) : resolve(process.cwd(), root);
  return {
    // 指定キーにバイト列を書き込む (親ディレクトリは必要に応じて作成する)
    async put(key, data) {
      // 書き込み先の絶対パスを安全に解決する
      const fullPath = resolveSafePath(rootAbs, key);
      // 書き込み先ディレクトリを作る (再帰生成、既存なら何もしない)
      await mkdir(dirname(fullPath), { recursive: true });
      // バイト列を書き込む (既存ファイルは上書き)
      await writeFile(fullPath, data);
    },
    // 指定キーのバイト列を読み出して返す (存在しなければ null)
    async get(key) {
      // 読み出し先の絶対パスを安全に解決する
      const fullPath = resolveSafePath(rootAbs, key);
      try {
        // ファイルを読み込んで Buffer を Uint8Array にして返す
        const buf = await readFile(fullPath);
        return new Uint8Array(buf);
      } catch (err) {
        // ENOENT (ファイル無し) は null として扱い、それ以外は再 throw
        if (isNotFoundError(err)) return null;
        throw err;
      }
    },
    // 指定キーを削除する (存在しなくてもエラーにしない: 冪等)
    async delete(key) {
      // 削除先の絶対パスを安全に解決する
      const fullPath = resolveSafePath(rootAbs, key);
      try {
        // ファイルを削除する
        await unlink(fullPath);
      } catch (err) {
        // ENOENT は無視する (二重削除でも安全に通す)
        if (isNotFoundError(err)) return;
        throw err;
      }
    },
  };
}

// fs エラーが ENOENT (ファイルが存在しない) かを判定する小さなガード
function isNotFoundError(err: unknown): boolean {
  // Node の I/O エラーには code プロパティが付く
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}
