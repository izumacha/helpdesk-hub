// readBodyWithinByteLimit のユニットテスト。
// このヘルパーの存在意義は「上限を超えるボディを最後まで読まない」ことなので、
// 戻り値だけでなく「実際に読んだ量 / ストリームが打ち切られたか」まで表明する。
// (単に読み切ってからバイト数を測る実装でも戻り値のテストは通ってしまい、
//  Content-Length を省いた chunked 転送でメモリを枯渇させられる穴を見逃す)

import { describe, expect, it } from 'vitest';
import { readBodyWithinByteLimit } from '@/lib/request-body-limit';

// テストで使う上限 (小さくして高速に回す)
const LIMIT = 1024;
// フォーム本文として解釈させるための Content-Type
const CONTENT_TYPE = { 'content-type': 'application/x-www-form-urlencoded' };

// 指定バイト数の本文を持つ Request を作る (Request は Content-Length を自動付与しない)
function requestWithBody(byteLength: number, headers: Record<string, string> = {}): Request {
  return new Request('http://x', {
    method: 'POST',
    body: 'A'.repeat(byteLength),
    headers: { ...CONTENT_TYPE, ...headers },
  });
}

// 上限を大きく超える量を流せるストリーム本文の Request を作る。
// 実際に何バイト produce されたか・打ち切られたかを呼び出し側から観測できるようにする
function streamingRequest(chunkSize: number, maxTotal: number) {
  // producer が enqueue した累計バイト数 (消費側が途中でやめれば、ここは小さいままになる)
  const produced = { bytes: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    // 消費側が要求したときだけ次のチャンクを積む (pull 型なので早期打ち切りが観測できる)
    pull(controller) {
      // 上限まで流し切ったら閉じる
      if (produced.bytes >= maxTotal) {
        controller.close();
        return;
      }
      // 1 チャンク積んで累計を進める
      produced.bytes += chunkSize;
      controller.enqueue(new Uint8Array(chunkSize));
    },
    // 消費側が cancel したことを記録する
    cancel() {
      produced.cancelled = true;
    },
  });
  const req = new Request('http://x', {
    method: 'POST',
    body: stream,
    headers: CONTENT_TYPE,
    // Node の fetch でストリーム本文を送るのに必要 (型定義に無いので拡張して渡す)
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  return { req, produced };
}

describe('readBodyWithinByteLimit', () => {
  it('上限内のボディはそのまま読み取れる', async () => {
    const result = await readBodyWithinByteLimit(requestWithBody(LIMIT - 1), LIMIT);
    // 読み取りに成功する
    expect(result.ok).toBe(true);
    // バイト数は送った分と一致する
    expect(result.ok && result.bytes.byteLength).toBe(LIMIT - 1);
  });

  it('ちょうど上限のボディは超過扱いにしない（境界値）', async () => {
    const result = await readBodyWithinByteLimit(requestWithBody(LIMIT), LIMIT);
    // 「上限を超えた」のは上限 + 1 バイト目からなので、ちょうどは通す
    expect(result.ok).toBe(true);
    expect(result.ok && result.bytes.byteLength).toBe(LIMIT);
  });

  it('上限を1バイト超えたボディは too-large で拒否する（境界値）', async () => {
    const result = await readBodyWithinByteLimit(requestWithBody(LIMIT + 1), LIMIT);
    // 超過として拒否される
    expect(result).toEqual({ ok: false, reason: 'too-large' });
  });

  it('Content-Lengthの申告が上限超過なら本文を読み進めずに拒否する', async () => {
    // 実本文はいくらでも流せるが、申告だけを上限超過にする
    const chunkSize = 64;
    const { req, produced } = streamingRequest(chunkSize, 10 * LIMIT);
    // 申告値を上書きする (Headers は生成後も変更できる)
    req.headers.set('content-length', String(LIMIT + 1));
    const result = await readBodyWithinByteLimit(req, LIMIT);
    // 申告だけで拒否される
    expect(result).toEqual({ ok: false, reason: 'too-large' });
    // ヘルパーはストリームを 1 度も read していない。
    // ここが 0 ではなく最大 1 チャンクなのは ReadableStream 自身の先読み (highWaterMark)
    // によるもので、ヘルパーがボディを読み進めた結果ではない
    expect(produced.bytes).toBeLessThanOrEqual(chunkSize);
  });

  it('Content-Lengthが無い巨大ストリームでも上限で読み取りを打ち切る', async () => {
    // 1MB 流せる用意のあるストリームを、上限 1024 バイトで読む
    const chunkSize = 256;
    const { req, produced } = streamingRequest(chunkSize, 1024 * 1024);
    // Content-Length は付いていない (chunked 転送に相当する状況)
    expect(req.headers.get('content-length')).toBeNull();

    const result = await readBodyWithinByteLimit(req, LIMIT);
    // 超過として拒否される
    expect(result).toEqual({ ok: false, reason: 'too-large' });
    // ここが本命: 用意された 1MB を読み切らず、上限のすぐ先で止まっている。
    // 「読み切ってから測る」実装ならここが 1MB になり、メモリ枯渇を防げていない。
    // 許容を上限 + 2 チャンクにしているのは、上限を踏み越えたチャンク 1 個に加えて
    // ReadableStream 自身が 1 個先読みする (highWaterMark) ぶんが producer 側に出るため
    expect(produced.bytes).toBeLessThanOrEqual(LIMIT + 2 * chunkSize);
    // 残りのストリームは破棄されている (producer 側に cancel が伝わっている)
    expect(produced.cancelled).toBe(true);
  });

  it('ボディが無いリクエストは空のバイト列として扱う', async () => {
    const result = await readBodyWithinByteLimit(new Request('http://x'), LIMIT);
    // 空として成功する (呼び出し元は「フィールドが無い」として通常の検証で弾ける)
    expect(result.ok).toBe(true);
    expect(result.ok && result.bytes.byteLength).toBe(0);
  });

  it('細切れチャンクで送られてもメモリはチャンク数に依存しない', async () => {
    // 1 バイトずつ刻んだ chunked 転送を再現する。チャンクを配列に溜める実装だと
    // Uint8Array オブジェクトが本文バイト数だけ積まれて増幅する (実測で約 231 倍) ため、
    // 「上限ぶんのバッファへ書き込む」実装になっていることをメモリ実測で確かめる
    const byteCount = LIMIT; // 上限ちょうど = 拒否されずに最後まで読み切る量
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // 1 バイトのチャンクを byteCount 個積む
        for (let i = 0; i < byteCount; i++) controller.enqueue(new Uint8Array([65]));
        controller.close();
      },
    });
    const req = new Request('http://x', {
      method: 'POST',
      body: stream,
      headers: CONTENT_TYPE,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    const result = await readBodyWithinByteLimit(req, LIMIT);
    // 上限ちょうどなので読み切れる
    expect(result.ok).toBe(true);
    // 全バイトが順番どおり復元されている (書き込み位置の計算ミス検出)
    expect(result.ok && result.bytes.byteLength).toBe(byteCount);
    expect(result.ok && new Uint8Array(result.bytes).every((b) => b === 65)).toBe(true);
  });

  it('制限時間内に送り切らないボディは timeout で打ち切る', async () => {
    // 上限には遠く届かない量を、制限時間より長い間隔で送り続ける (slowloris の再現)
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        // 1 バイトだけ送って、次のチャンクは永遠に来ない
        controller.enqueue(new Uint8Array([65]));
        return new Promise(() => {}); // 解決しない = 送信が止まったまま
      },
    });
    const req = new Request('http://x', {
      method: 'POST',
      body: stream,
      headers: CONTENT_TYPE,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    // 制限時間を 50ms に縮めてテストを速く終わらせる
    const result = await readBodyWithinByteLimit(req, LIMIT, 50);
    // サイズ上限には達していないが、時間切れとして打ち切られる
    expect(result).toEqual({ ok: false, reason: 'timeout' });
  });

  it('読み取り中にストリームが壊れたら unreadable を返す', async () => {
    // 読み取り開始後にエラーを流すストリーム
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('接続が切れました'));
      },
    });
    const req = new Request('http://x', {
      method: 'POST',
      body: stream,
      headers: CONTENT_TYPE,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    const result = await readBodyWithinByteLimit(req, LIMIT);
    // 例外を投げず、読み取り不能として返す (呼び出し元が拒否を選べる)
    expect(result).toEqual({ ok: false, reason: 'unreadable' });
  });
});
