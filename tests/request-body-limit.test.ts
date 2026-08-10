// readBodyWithinByteLimit のユニットテスト。
// このヘルパーの存在意義は「上限を超えるボディを最後まで読まない」ことなので、
// 戻り値だけでなく「実際に読んだ量 / ストリームが打ち切られたか」まで表明する。
// (単に読み切ってからバイト数を測る実装でも戻り値のテストは通ってしまい、
//  Content-Length を省いた chunked 転送でメモリを枯渇させられる穴を見逃す)

import { describe, expect, it } from 'vitest';
import {
  readBodyWithinByteLimit,
  readFormWithinByteLimit,
  readTextWithinByteLimit,
  bodyRejectStatus,
  DEFAULT_BODY_IDLE_TIMEOUT_MS,
  DEFAULT_BODY_TOTAL_TIMEOUT_MS,
} from '@/lib/request-body-limit';
// 経路ごとに上書きしている全体期限 (関係の表明に使う)
import { INBOUND_EMAIL_BODY_TOTAL_TIMEOUT_MS } from '@/lib/webhook-body-limits';

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

  // 申告値をログに残せるよう、拒否結果に載せて返す。上限値だけでは全部の 413 行が同じ文言に
  // なり、「正規の送信者が上限を少し超えている」と「桁違いのサイズで探られている」を
  // 運用者が区別できない
  it('ヘッダ申告での拒否は申告値を結果に載せて返す', async () => {
    const req = requestWithBody(1, { 'content-length': String(LIMIT + 1) });
    const result = await readBodyWithinByteLimit(req, LIMIT);
    expect(result).toEqual({ ok: false, reason: 'too-large', declaredLength: LIMIT + 1 });
  });

  // ストリーム側で打ち切った場合は「上限を踏み越えた時点で読むのをやめる」設計上、
  // 実サイズが分からない。無い値をでっち上げないことを表明する
  it('ストリームでの打ち切りは申告値を持たない', async () => {
    const result = await readBodyWithinByteLimit(requestWithBody(LIMIT + 1), LIMIT);
    expect(result).toEqual({ ok: false, reason: 'too-large' });
  });

  it('Content-Lengthの申告が上限超過なら本文を読み進めずに拒否する', async () => {
    // 実本文はいくらでも流せるが、申告だけを上限超過にする
    const chunkSize = 64;
    const { req, produced } = streamingRequest(chunkSize, 10 * LIMIT);
    // 申告値を上書きする (Headers は生成後も変更できる)
    req.headers.set('content-length', String(LIMIT + 1));
    const result = await readBodyWithinByteLimit(req, LIMIT);
    // 申告だけで拒否される (申告値はログの切り分け用にそのまま載せて返す)
    expect(result).toEqual({ ok: false, reason: 'too-large', declaredLength: LIMIT + 1 });
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
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unparsable');
      // 原因の例外を捨てずに載せて返す (§6 エラーを握り潰さない)
      expect(result.cause).toBeInstanceOf(Error);
    }
  });

  // 上のケースは Content-Type がフォーム系でない場合で、メール取り込みルートは手前で
  // Content-Type を振り分けるため到達しない。**実運用で起こるのは「Content-Type は multipart
  // なのに本文が壊れている」形**なので、そちらでも例外が付いて返ることを別途固定する
  // (この経路が無いと、ルートが握れる cause は実質テストされていないことになる)
  // §9「機密情報・PII をログに漏らさない」の実測固定。この cause は sso-acs と
  // マジックリンクのコールバック — **SAML アサーションとログイントークンを本文に持つ経路** —
  // でサーバーログへ書き出される。現在の undici は本文を例外に載せないが、それはコメントで
  // 観測を書いているだけでは守れない (パーサ改善で該当パートのヘッダを message に含める
  // 実装は珍しくない)。将来のランタイム更新で載るようになったらここで落ちる
  it('解析失敗の例外に本文の中身が入らない (ログへ書き出すため)', async () => {
    // 本文に見つけやすい印を仕込む (実際は SAMLResponse やトークンが入る位置)
    const marker = 'SECRET-MARKER-DO-NOT-LOG';
    const req = new Request('http://x', {
      method: 'POST',
      body: `--X\r\nContent-Disposition: form-data; name="SAMLResponse"\r\n\r\n${marker}`,
      headers: { 'content-type': 'multipart/form-data; boundary=X' },
    });
    const result = await readFormWithinByteLimit(req, LIMIT);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'unparsable') {
      // console.warn(msg, cause) が実際に描画するのは message と stack
      const rendered = `${String((result.cause as Error).message)}\n${String((result.cause as Error).stack)}`;
      expect(rendered).not.toContain(marker);
    }
  });

  it('multipart の本文が壊れていても unparsable と原因の例外を返す', async () => {
    // boundary は宣言しているが、パートのヘッダが途中で切れている本文
    const req = new Request('http://x', {
      method: 'POST',
      body: '--X\r\nContent-Dispo',
      headers: { 'content-type': 'multipart/form-data; boundary=X' },
    });
    const result = await readFormWithinByteLimit(req, LIMIT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unparsable');
      // 原因の例外が付く。**ただし undici は multipart の失敗をすべて同じ 1 種類の
      // TypeError に潰すため、ここで理由の内訳までは判別できない** (型と発生箇所だけが分かる)。
      // 上流が詳細を載せるようになればこの表明はより強い意味を持つ
      expect(result.cause).toBeInstanceOf(TypeError);
    }
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

describe('readTextWithinByteLimit', () => {
  // このヘルパーの存在意義は「req.text() と同じ文字列が得られること」なので、
  // 復号結果そのものを req.text() と突き合わせて表明する
  // (署名検証を通る経路がこの等価性に依存している。崩れると正規リクエストが全て検証失敗になる)
  it('req.text() と同じ文字列を返す (マルチバイト文字を含んでも一致する)', async () => {
    // 日本語 + サロゲートペア (絵文字) を含めて UTF-8 復号の往復を確かめる
    const text = '日本語のメッセージ🚀';
    // 同じ本文で 2 つの Request を作り、片方は req.text()、片方はヘルパーで読む
    const expected = await new Request('http://x', { method: 'POST', body: text }).text();
    const result = await readTextWithinByteLimit(
      new Request('http://x', { method: 'POST', body: text }),
      LIMIT,
    );
    // 読み取りに成功する
    expect(result.ok).toBe(true);
    // req.text() と 1 文字も違わない
    if (result.ok) expect(result.text).toBe(expected);
  });

  // 実運用で起こりうる本文の形を一通り並べて req.text() と突き合わせる。
  // 特に BOM と不正バイト列は復号器の設定 (ignoreBOM / fatal) の違いが表に出る形なので、
  // 署名検証の入力が変わっていないことをここで機械的に押さえる
  it.each([
    ['BOM 無し', [0x61, 0x62, 0x63]],
    ['先頭に BOM 1 つ', [0xef, 0xbb, 0xbf, 0x61]],
    ['不正なバイト列を含む', [0x61, 0xff, 0xfe, 0x62]],
  ])('req.text() と同じ文字列を返す (%s)', async (_name, byteValues) => {
    // 同じバイト列から 2 つの Request を作り、片方は req.text()、片方はヘルパーで読む
    const bytes = new Uint8Array(byteValues as number[]);
    const expected = await new Request('http://x', { method: 'POST', body: bytes }).text();
    const result = await readTextWithinByteLimit(
      new Request('http://x', { method: 'POST', body: bytes }),
      LIMIT,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe(expected);
  });

  // 既知の唯一の差異を明示的に固定する。undici の req.text() は BOM を自前で 1 つ剥がしてから
  // TextDecoder に渡すため二重に剥がれ、こちらは 1 つだけ剥がす。
  // 「一致しない」ことを表明するのは、この差分が (a) 意図して受け入れたものであり
  // (b) どちらの結果でも署名は不一致になる = 検証が緩む方向ではない、と記録に残すため。
  // 将来 req.text() 側の実装が変わって一致するようになれば、このテストが落ちて気付ける
  it('BOM が 2 つ続く本文だけは req.text() と結果が異なる (既知の差異)', async () => {
    // BOM を 2 つ並べた後に 'a' を置く
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x61]);
    const viaReqText = await new Request('http://x', { method: 'POST', body: bytes }).text();
    const result = await readTextWithinByteLimit(
      new Request('http://x', { method: 'POST', body: bytes }),
      LIMIT,
    );
    expect(result.ok).toBe(true);
    // req.text() は BOM を 2 つとも失う
    expect(viaReqText).toBe('a');
    // こちらは 1 つだけ剥がすので 2 つ目が残る (署名対象としてはこちらの方が受信バイト列に近い)
    if (result.ok) expect(result.text).toBe('﻿a');
  });

  it('サイズ超過は復号まで進まず too-large をそのまま返す', async () => {
    const result = await readTextWithinByteLimit(requestWithBody(LIMIT + 1), LIMIT);
    // バイト列側の拒否理由が上書きされずに伝わる
    expect(result).toEqual({ ok: false, reason: 'too-large' });
  });
});

describe('bodyRejectStatus', () => {
  // 拒否理由 → HTTP ステータスの振り分けは複数のルートが依存する共通判断なので、
  // 全理由を網羅して固定する (理由を増やしたときにここで振り分けを決め忘れない)
  it('サイズ超過だけ 413、それ以外は 400 に振り分ける', () => {
    expect(bodyRejectStatus('too-large')).toBe(413);
    expect(bodyRejectStatus('timeout')).toBe(400);
    expect(bodyRejectStatus('unreadable')).toBe(400);
    expect(bodyRejectStatus('unparsable')).toBe(400);
  });
});

describe('既定の制限時間', () => {
  // **slowloris 耐性を決めるのはこの 2 つ**なので、値そのものではなく満たすべき関係を固定する。
  // (値を写経すると、両方を同時に書き換える変更を素通ししてしまう)
  // 実時間で待って挙動から確かめる形にしないのは、既定値ぶん (数十秒) テストが止まるため。

  it('無通信の上限は全体期限より短い', () => {
    // 逆転すると無通信の検知が一度も働かず、「送るのをやめた接続」が全体期限まで居座る
    expect(DEFAULT_BODY_IDLE_TIMEOUT_MS).toBeLessThan(DEFAULT_BODY_TOTAL_TIMEOUT_MS);
  });

  it('全体期限は Node 既定の requestTimeout (300 秒) より短い', () => {
    // 超えるとサーバー側で先に切られ、こちらの打ち切りが一度も効かなくなる
    expect(DEFAULT_BODY_TOTAL_TIMEOUT_MS).toBeLessThan(300_000);
  });

  // 経路ごとに上書きしている唯一の全体期限も同じ関係を満たす必要がある。
  // **むしろこちらの方が天井に近い** (240 秒 / 300 秒) ので、緩める変更はここで止める
  it('メール取り込みの全体期限も無通信の上限と requestTimeout の間に収まる', () => {
    expect(INBOUND_EMAIL_BODY_TOTAL_TIMEOUT_MS).toBeGreaterThan(DEFAULT_BODY_IDLE_TIMEOUT_MS);
    expect(INBOUND_EMAIL_BODY_TOTAL_TIMEOUT_MS).toBeLessThan(300_000);
  });

  it('無通信の上限は、保持数が伸びすぎない範囲に収まっている', () => {
    // 長くするほど「ヘッダだけ送る接続」の同時保持数が増える (この経路には同時保持数の
    // 歯止めが無い)。一方で短すぎるとイベントループの停止で正規リクエストを誤って落とす。
    // 現在の判断はその間の 30 秒で、上下どちらへ大きく動かすときは根拠を添えて見直すこと
    expect(DEFAULT_BODY_IDLE_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
    expect(DEFAULT_BODY_IDLE_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});
