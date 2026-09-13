// Vitest のテスト DSL
import { afterEach, describe, expect, it } from 'vitest';
// Node 標準の TCP サーバ (偽 SMTP サーバをテスト内に立てるのに使う)
import net from 'node:net';
// テスト対象
import { createNodemailerEmailSender } from '@/lib/email/nodemailer-email-sender';

/**
 * この契約テストが要る理由:
 *
 * SMTP アダプタは本番の唯一の送信経路なのに、テストが `console` ドライバ側にしか無く、
 * nodemailer を major 跨ぎで更新しても「ビルドもテストも全緑」のまま通ってしまう状態だった
 * (実際 9 → 10 の更新時にそうなっていた)。CI の緑が判断材料にならない fail-open なので、
 * 外部サービスは呼ばず (§11「外部 API はモックして実際には呼ばない」)、ループバックに立てた
 * 最小の偽 SMTP サーバへ実際に 1 通流して、アダプタの契約を固定する。
 *
 * 固定するのは「アダプタが約束していること」だけに絞る:
 *   - EmailMessage の各フィールドが SMTP のエンベロープ / ヘッダ / 本文へ落ちること
 *   - 認証情報が両方揃ったときだけ AUTH を送ること (匿名 SMTP 対応の条件分岐)
 * nodemailer 自身の MIME 組み立ての細部は上流の責務なので踏み込まない。
 */

// 偽 SMTP サーバ 1 台分のハンドル (テストから覗ける記録と後片付け)
interface FakeSmtpServer {
  port: number; // 実際に待ち受けているポート (0 指定で OS に割り当てさせた値)
  commands: string[]; // 受け取った SMTP コマンド行 (DATA 本文は含まない)
  messages: string[]; // DATA で受け取った本文 (ヘッダ + 本体の生テキスト)
  close: () => Promise<void>; // 後片付け
}

/**
 * 最小限の SMTP 応答だけを返す偽サーバを立てる。
 *
 * `advertiseAuth` が true のときだけ EHLO の応答で AUTH PLAIN を広告する。
 * 広告しない限り nodemailer は AUTH を送らないため、「AUTH が来たかどうか」で
 * アダプタ側が auth ブロックを渡したかを観測できる。
 */
function startFakeSmtpServer(options: { advertiseAuth: boolean }): Promise<FakeSmtpServer> {
  // 受け取ったコマンド行を貯める配列 (テストの検証対象)
  const commands: string[] = [];
  // 受け取ったメール本文を貯める配列 (テストの検証対象)
  const messages: string[] = [];

  // 1 接続ぶんの会話を処理する TCP サーバ
  const server = net.createServer((socket) => {
    // 行の途中で TCP チャンクが切れても取りこぼさないための持ち越しバッファ
    let buffer = '';
    // DATA コマンド後は本文モードに入る (コマンドとして解釈しない)
    let inData = false;
    // 本文モード中に受け取った行を貯める
    let dataLines: string[] = [];

    // 接続直後のあいさつ (220 を返さないとクライアントは進まない)
    socket.write('220 localhost ESMTP fake\r\n');

    // 受信のたびに行単位へ切り分けて処理する
    socket.on('data', (chunk) => {
      // 持ち越し分と今回の受信を連結する
      buffer += chunk.toString('utf8');
      // 完全な行 (CRLF 終端) がある限り取り出す
      let index = buffer.indexOf('\r\n');
      while (index !== -1) {
        // 1 行を取り出し、バッファから取り除く
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);

        if (inData) {
          // 単独のドット行が本文の終端を表す
          if (line === '.') {
            // 本文モードを抜け、貯めた行を 1 通として記録する
            inData = false;
            messages.push(dataLines.join('\r\n'));
            dataLines = [];
            socket.write('250 2.0.0 OK: queued\r\n');
          } else {
            // 行頭のドットは送信側がエスケープするので 1 つ戻す (dot-stuffing の解除)
            dataLines.push(line.startsWith('..') ? line.slice(1) : line);
          }
        } else {
          // コマンド行として記録する
          commands.push(line);
          // コマンド名は大文字小文字を区別しない
          const command = line.toUpperCase();
          if (command.startsWith('EHLO') || command.startsWith('HELO')) {
            // 拡張の広告。AUTH を広告するかどうかだけがテストごとに変わる
            socket.write('250-localhost\r\n');
            if (options.advertiseAuth) socket.write('250-AUTH PLAIN\r\n');
            socket.write('250 SIZE 10240000\r\n');
          } else if (command.startsWith('AUTH')) {
            // 資格情報の中身は見ない (このテストで見たいのは「送ったかどうか」だけ)
            socket.write('235 2.7.0 Accepted\r\n');
          } else if (command.startsWith('MAIL FROM') || command.startsWith('RCPT TO')) {
            // エンベロープは無条件に受理する
            socket.write('250 2.1.0 OK\r\n');
          } else if (command.startsWith('DATA')) {
            // ここから本文モードへ入る
            inData = true;
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          } else if (command.startsWith('QUIT')) {
            // 切断して 1 接続ぶんの会話を終える
            socket.write('221 2.0.0 Bye\r\n');
            socket.end();
          } else {
            // 未知のコマンドも受理しておく (テストを SMTP の網羅実装にしないため)
            socket.write('250 2.0.0 OK\r\n');
          }
        }

        // 次の行を探す
        index = buffer.indexOf('\r\n');
      }
    });

    // 相手都合の切断でテストを落とさない (QUIT 後の RST など)
    socket.on('error', () => {});
  });

  // ポート 0 で待ち受け、OS が割り当てた実ポートを解決して返す
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      // listen 後は必ずアドレスが取れる (net.AddressInfo)
      const address = server.address() as net.AddressInfo;
      resolve({
        port: address.port,
        commands,
        messages,
        // クローズ完了まで待てるように Promise 化する (テスト間でポートを残さない)
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

// 起動した偽サーバを afterEach で確実に閉じるための置き場 (§8 リソースを確実に解放する)
let running: FakeSmtpServer | null = null;

afterEach(async () => {
  // テストが途中で落ちてもサーバを残さない
  if (running) {
    await running.close();
    running = null;
  }
});

describe('createNodemailerEmailSender', () => {
  // EmailMessage の各フィールドが SMTP のエンベロープ・ヘッダ・本文へ落ちること
  it('宛先・件名・本文・Message-ID・追加ヘッダを SMTP へ渡す', async () => {
    // AUTH を広告しない匿名 SMTP (Mailhog 等の開発リレー相当)
    running = await startFakeSmtpServer({ advertiseAuth: false });
    // 差出人だけを既定値として持つ sender を生成する
    const sender = createNodemailerEmailSender({
      host: '127.0.0.1',
      port: running.port,
      from: '"HelpDesk Hub" <no-reply@example.com>',
    });

    // 1 件送信する (messageId と headers は任意フィールドなので明示して通す)
    await sender.send({
      to: 'requester@example.com',
      subject: 'Ticket received',
      text: 'plain body',
      html: '<p>html body</p>',
      messageId: '<ticket-42@helpdesk.example.com>',
      headers: { 'Auto-Submitted': 'auto-replied' },
    });

    // エンベロープの宛先がそのまま渡っていること (ここが落ちると誰にも届かない)
    expect(running.commands).toContain('RCPT TO:<requester@example.com>');
    // 1 通だけ受け取っていること
    expect(running.messages).toHaveLength(1);
    const raw = running.messages[0];
    // 差出人は config の既定値が使われること。nodemailer は表示名を解析して組み立て直すため、
    // 引用符が不要な表示名 (特殊文字なし) では設定の `"HelpDesk Hub"` から引用符が外れる
    expect(raw).toContain('From: HelpDesk Hub <no-reply@example.com>');
    // 件名がそのまま載ること (ASCII なのでエンコードされない)
    expect(raw).toContain('Subject: Ticket received');
    // 呼び出し側が決めた Message-ID が自動採番に上書きされないこと (スレッド継続の要)
    expect(raw).toContain('Message-ID: <ticket-42@helpdesk.example.com>');
    // 追加ヘッダが落ちないこと (自動返信ループ防止の Auto-Submitted)
    expect(raw).toContain('Auto-Submitted: auto-replied');
    // text / html の両方が本文に入ること (受信クライアント差の吸収)
    expect(raw).toContain('plain body');
    expect(raw).toContain('html body');
  });

  // 認証情報が揃っていないときは AUTH を送らないこと (匿名 SMTP 対応の条件分岐)
  it('user / password が欠けていれば AUTH を送らない', async () => {
    // AUTH を広告する = 送れる状況をあえて作り、それでも送らないことを見る
    running = await startFakeSmtpServer({ advertiseAuth: true });
    // password だけ与える (片方だけ揃った状態)
    const sender = createNodemailerEmailSender({
      host: '127.0.0.1',
      port: running.port,
      password: 'only-password',
      from: 'no-reply@example.com',
    });

    // 送信自体は成功すること
    await sender.send({
      to: 'requester@example.com',
      subject: 'No auth',
      text: 'body',
      html: '<p>body</p>',
    });

    // AUTH コマンドが 1 つも送られていないこと
    expect(running.commands.some((line) => line.toUpperCase().startsWith('AUTH'))).toBe(false);
  });

  // 認証情報が両方揃っていれば AUTH を送ること
  it('user / password が揃っていれば AUTH を送る', async () => {
    // AUTH を広告する SMTP (本番相当)
    running = await startFakeSmtpServer({ advertiseAuth: true });
    // 両方を与える
    const sender = createNodemailerEmailSender({
      host: '127.0.0.1',
      port: running.port,
      user: 'smtp-user',
      password: 'smtp-password',
      from: 'no-reply@example.com',
    });

    // 送信する
    await sender.send({
      to: 'requester@example.com',
      subject: 'With auth',
      text: 'body',
      html: '<p>body</p>',
    });

    // AUTH コマンドが送られていること
    expect(running.commands.some((line) => line.toUpperCase().startsWith('AUTH'))).toBe(true);
  });
});
