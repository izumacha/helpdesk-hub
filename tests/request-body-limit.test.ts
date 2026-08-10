// readBodyWithinByteLimit のユニットテスト。
// このヘルパーの存在意義は「上限を超えるボディを最後まで読まない」ことなので、
// 戻り値だけでなく「実際に読んだ量 / ストリームが打ち切られたか」まで表明する。
// (単に読み切ってからバイト数を測る実装でも戻り値のテストは通ってしまい、
//  Content-Length を省いた chunked 転送でメモリを枯渇させられる穴を見逃す)

import { describe, expect, it } from 'vitest';
import { readBodyWithinByteLimit, readFormWithinByteLimit } from '@/lib/request-body-limit';

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

  // 境界値: Content-Length の申告が「ちょうど上限」なら超過ではないので通す。
  // 上の 3 ケースは new Request() が Content-Length を付けないためストリーム側の検査しか
  // 通っておらず、ヘッダ検査の > を >= に取り違えても誰も落ちない状態だった
  // (実測: 取り違えても全テストが緑のまま)。実ブラウザ・実 IdP の POST は必ず
  // Content-Length を付けるので、ここが本番の主経路になる
  it('Content-Lengthの申告がちょうど上限なら通す（境界値）', async () => {
    const req = requestWithBody(LIMIT, { 'content-length': String(LIMIT) });
    const result = await readBodyWithinByteLimit(req, LIMIT);
    // ちょうどは超過ではないので読み切れる (>= に取り違えるとここで失敗する)
    expect(result.ok).toBe(true);
    expect(result.ok && result.bytes.byteLength).toBe(LIMIT);
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

  // 注: メモリ使用量そのものはここでは表明しない。増幅が観測できる規模 (100 万チャンク級) は
  // 1 ケースで 1 分以上かかり、観測できる規模まで落とすと通常のヒープ変動に埋もれて
  // 判定が不安定になるため。チャンク数に依存しないことは実装方針 (チャンクを配列に溜めず、
  // 伸長バッファへ書き込む) と、モジュール冒頭に記録した実測値で担保する。
  // このケースが守るのは「多数の細切れチャンクでも書き込み位置がずれず正しく復元できる」こと
  it('細切れチャンクで送られても本文を正しく復元できる', async () => {
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
    // 全バイトが順番どおり復元されている (伸長時の詰め替え・書き込み位置の計算ミスを検出)
    expect(result.ok && result.bytes.byteLength).toBe(byteCount);
    expect(result.ok && result.bytes.every((b) => b === 65)).toBe(true);
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

    // 無通信の許容時間を 50ms に縮めてテストを速く終わらせる
    const result = await readBodyWithinByteLimit(req, LIMIT, 50);
    // サイズ上限には達していないが、次のチャンクが来ないので打ち切られる
    expect(result).toEqual({ ok: false, reason: 'timeout' });
  });

  // 上のケースの裏返し。制限が「全体の所要時間」だと、細い上り回線から時間をかけて
  // 送ってくる正規の利用者 (SSO は利用者のブラウザから POST される) まで巻き添えで
  // 落ちてしまう。無通信時間で測っているからこそ、遅くても送り続けていれば通る
  it('無通信の許容時間より長くかかっても、送り続けていれば読み切れる', async () => {
    // 1 チャンクあたりの待ち時間 (無通信の許容時間より十分に短い)
    const chunkDelayMs = 20;
    // 送るチャンク数。全体では chunkDelayMs * 5 = 100ms かかり、許容時間 50ms を上回る
    const chunkCount = 5;
    // 送信済みチャンク数
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        // 予定数を送り終えたらストリームを閉じる
        if (sent >= chunkCount) {
          controller.close();
          return;
        }
        // 少し待ってから 1 バイト送る (遅いが止まってはいない回線の再現)
        await new Promise((resolve) => setTimeout(resolve, chunkDelayMs));
        controller.enqueue(new Uint8Array([65]));
        sent++;
      },
    });
    const req = new Request('http://x', {
      method: 'POST',
      body: stream,
      headers: CONTENT_TYPE,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    // 無通信の許容時間 (50ms) < 全体の所要時間 (約 100ms)、かつ全体期限 (5s) には余裕がある条件で読む
    const result = await readBodyWithinByteLimit(req, LIMIT, 50, 5_000);
    // 全体期限「だけ」で打ち切る実装ならここで timeout になり失敗する
    expect(result.ok).toBe(true);
    // 送ったバイトはすべて読み取れている
    expect(result.ok && result.bytes.byteLength).toBe(chunkCount);
  });

  // 上の裏返し。無通信の許容時間だけでは slowloris を止められない: 攻撃者はその直前に
  // 1 バイトずつ送るだけでタイマーを永久に張り直せる。張り直さない全体期限が要る
  it('無通信を挟まず送り続けても、全体期限を超えたら打ち切る', async () => {
    // チャンク間隔は無通信の許容時間より短いので、無通信タイマーは一度も発火しない
    const chunkDelayMs = 10;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        // ずっと送り続ける (上限バイト数には到底届かない速度)
        await new Promise((resolve) => setTimeout(resolve, chunkDelayMs));
        controller.enqueue(new Uint8Array([65]));
      },
    });
    const req = new Request('http://x', {
      method: 'POST',
      body: stream,
      headers: CONTENT_TYPE,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    // 無通信の許容時間 (100ms) はチャンク間隔 (10ms) より長いので発火しない。
    // 全体期限 (80ms) だけが効く条件にする
    const result = await readBodyWithinByteLimit(req, LIMIT, 100, 80);
    // 全体期限が無い実装ではこのループが終わらずテストがタイムアウトする
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

// フォーム化まで含めた層のテスト。バイト列側 (上記) と分けているのは、こちらの関心事が
// 「サイズ検査を通したバイト列を、元の Content-Type のまま正しくパースし直せるか」だから
describe('readFormWithinByteLimit', () => {
  it('urlencoded のフォームをフィールドとして取り出せる', async () => {
    const req = new Request('http://x', {
      method: 'POST',
      body: new URLSearchParams({ SAMLResponse: 'abc', RelayState: '/tickets' }),
    });
    const result = await readFormWithinByteLimit(req, LIMIT);
    // パースに成功する
    expect(result.ok).toBe(true);
    // 各フィールドが元の値のまま取り出せる
    expect(result.ok && result.form.get('SAMLResponse')).toBe('abc');
    expect(result.ok && result.form.get('RelayState')).toBe('/tickets');
  });

  // multipart は Content-Type の boundary パラメータが無いとパースできない。
  // ヘルパーが元リクエストの Content-Type をそのまま引き継いでいることを固定する
  // (引き継ぎを落とすと本番の IdP が multipart で POST してきたときだけ壊れ、
  //  urlencoded しか送らないテストでは気付けない)
  it('multipart の boundary を引き継いでパースできる', async () => {
    // FormData を渡すと boundary 付きの Content-Type が自動で組み立てられる
    const form = new FormData();
    form.set('SAMLResponse', 'multipart-value');
    const req = new Request('http://x', { method: 'POST', body: form });
    // 前提確認: boundary 付きの multipart として送られている
    expect(req.headers.get('content-type')).toContain('multipart/form-data; boundary=');

    const result = await readFormWithinByteLimit(req, LIMIT);
    // boundary が引き継がれていればパースできる (落とすと unparsable になる)
    expect(result.ok).toBe(true);
    expect(result.ok && result.form.get('SAMLResponse')).toBe('multipart-value');
  });

  it('フォームとして解釈できない本文は unparsable で拒否する', async () => {
    // Content-Type が JSON なのでフォームとしてはパースできない
    const req = new Request('http://x', {
      method: 'POST',
      body: '{"broken":',
      headers: { 'content-type': 'application/json' },
    });
    const result = await readFormWithinByteLimit(req, LIMIT);
    // 例外を投げず、パース不能として返す
    expect(result).toEqual({ ok: false, reason: 'unparsable' });
  });

  it('サイズ超過はパースまで進まず too-large をそのまま返す', async () => {
    const req = new Request('http://x', {
      method: 'POST',
      body: 'A'.repeat(LIMIT + 1),
      headers: CONTENT_TYPE,
    });
    const result = await readFormWithinByteLimit(req, LIMIT);
    // バイト列側の拒否理由が上書きされずに伝わる (unparsable に化けない)
    expect(result).toEqual({ ok: false, reason: 'too-large' });
  });
});
