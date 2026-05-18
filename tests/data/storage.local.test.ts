// ローカル FS ストレージ Adapter の単体テスト。
// 主に「ルート配下に閉じる」「冪等な delete」「未存在キーで null を返す」を検証する。

// Vitest の DSL
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// Node の標準モジュール (一時ディレクトリ作成・後始末)
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// 検証対象
import { createLocalStorage } from '@/data/adapters/local/storage.local';

// 各テスト用の一時ルートを保持する変数 (beforeEach で作成 / afterEach で削除)
let rootDir: string;

beforeEach(async () => {
  // 一意な一時ディレクトリを作って毎回独立な状態を作る
  rootDir = await mkdtemp(join(tmpdir(), 'helpdesk-hub-storage-'));
});

afterEach(async () => {
  // テスト後に一時ディレクトリを丸ごと削除する (失敗しても無視)
  await rm(rootDir, { recursive: true, force: true });
});

describe('LocalStoragePort', () => {
  // put → get で同じバイト列が返ること
  it('put + get round-trips bytes', async () => {
    const storage = createLocalStorage(rootDir);
    // 中身は「hello」を Uint8Array にしたもの
    const data = new Uint8Array([104, 101, 108, 108, 111]);
    // 書き込み (tenant/ticket/uuid.jpg の形式)
    await storage.put('tenant-a/t-1/abc.jpg', data, {
      contentType: 'image/jpeg',
      size: data.length,
    });
    // 読み出すと同じバイト列が返る
    const read = await storage.get('tenant-a/t-1/abc.jpg');
    expect(read).toEqual(data);
    // 物理ファイルもルート配下に存在する
    const fileStat = await stat(join(rootDir, 'tenant-a/t-1/abc.jpg'));
    expect(fileStat.isFile()).toBe(true);
  });

  // 存在しないキーは null
  it('get returns null when the file does not exist', async () => {
    const storage = createLocalStorage(rootDir);
    expect(await storage.get('nonexistent/key.jpg')).toBeNull();
  });

  // delete は冪等 (二重削除でも安全)
  it('delete is idempotent', async () => {
    const storage = createLocalStorage(rootDir);
    const data = new Uint8Array([1, 2, 3]);
    await storage.put('t/k.bin', data, { contentType: 'application/octet-stream', size: 3 });
    // 1 回目で削除
    await storage.delete('t/k.bin');
    // 2 回目もエラーにならない
    await expect(storage.delete('t/k.bin')).resolves.toBeUndefined();
    // 読み出しは null になる
    expect(await storage.get('t/k.bin')).toBeNull();
  });

  // ../ などでルート外に出ようとするキーは拒否される
  it('rejects keys that escape the root', async () => {
    const storage = createLocalStorage(rootDir);
    // ルート外へ出ようとする悪意のあるキー
    await expect(
      storage.put('../escape.jpg', new Uint8Array([0]), {
        contentType: 'image/jpeg',
        size: 1,
      }),
    ).rejects.toThrow(/escapes root/);
    // get / delete でも同様に拒否
    await expect(storage.get('../escape.jpg')).rejects.toThrow(/escapes root/);
    await expect(storage.delete('../escape.jpg')).rejects.toThrow(/escapes root/);
  });
});
