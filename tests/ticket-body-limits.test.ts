// 認証済みチケット書き込み 2 経路の「ボディ受け入れ枠」と「拒否理由 → 文言」の表を、
// 本番の定義そのもので固定する。
//
// なぜここで表明するか:
//   - 上限値は **ドメイン定数から導出している**ことが要点で、値そのものを写して比べても
//     導出が切れた退行 (誰かが直書きの数値へ「単純化」した等) を捕まえられない。
//     そこでドメイン定数側を動かしたときに枠が追随するかを確かめる形で書く。
//   - 文言表は `timeout` / `unreadable` をルート越しに発火させるのが重い (実時間で無通信を
//     待つ必要がある) ため、表そのものとヘルパーの組で表明する
//     (`tests/webhook-body-reject-messages.test.ts` と同じ理由)。

import { describe, expect, it, vi, afterEach } from 'vitest';
// 検証対象の上限値・制限時間 (本番の route が参照するのと同じ定義)
import {
  ATTACHMENT_UPLOAD_BODY_TOTAL_TIMEOUT_MS,
  ATTACHMENT_UPLOAD_MAX_BODY_BYTES,
  TICKET_JSON_MAX_BODY_BYTES,
} from '@/lib/ticket-body-limits';
// 上限の導出元となるドメイン定数
import { MAX_ATTACHMENTS_PER_UPLOAD, MAX_ATTACHMENT_SIZE_BYTES } from '@/domain/attachment';
// 既定・延長版の制限時間 (この経路の全体期限が満たすべき関係の比較対象)
import {
  DEFAULT_BODY_TOTAL_TIMEOUT_MS,
  STALL_TOLERANT_BODY_IDLE_TIMEOUT_MS,
} from '@/lib/request-body-limit';
// 検証対象の文言表 (本番の route が参照するのと同じ表)
import {
  TICKET_JSON_BODY_REJECT_MESSAGES,
  TICKET_MULTIPART_BODY_REJECT_MESSAGES,
} from '@/lib/ticket-body-reject-messages';
// 表を実際に応答へ変換するヘルパー (Webhook 3 経路と共有)
import { bodyRejectResponse } from '@/lib/body-reject-response';
// 失敗結果・文言表の型 (2 つの表を 1 つのループで回すために型を広げる箇所で使う)
import type { BodyRejectFailure, BodyRejectMessages } from '@/lib/request-body-limit';

afterEach(() => {
  // bodyRejectResponse は console.warn を出すので、差し替えたモックを毎回戻す
  vi.restoreAllMocks();
});

describe('ATTACHMENT_UPLOAD_MAX_BODY_BYTES', () => {
  // 検証を通りうる最大の本文 (件数上限ぶんのファイルがすべてサイズ上限) は必ず枠に収まる。
  // ここが崩れると、正規のアップロードが 422 (具体的な文言) ではなく 413 で弾かれるようになる
  it('件数上限 × 1 件あたりのサイズ上限を超える枠を持つ', () => {
    // ドメイン定数から計算した「ファイルバイト列だけの最大量」
    const maxFileBytes = MAX_ATTACHMENTS_PER_UPLOAD * MAX_ATTACHMENT_SIZE_BYTES;
    // 枠はそれより大きい (テキストフィールドと multipart の境界行ぶんの余裕がある)
    expect(ATTACHMENT_UPLOAD_MAX_BODY_BYTES).toBeGreaterThan(maxFileBytes);
  });

  // 余裕の取り方が過大でないことも押さえる (枠が「ファイル分 + 数 MB」の桁を超えると、
  // 上限を設けた本来の目的 = 1 リクエストで確保できる量を見積もれる形にする、が薄れる)。
  // 上限 = ファイル分 + 1MB を意図しているので、2 倍には決して届かない
  it('ファイルバイト列の 2 倍には届かない', () => {
    const maxFileBytes = MAX_ATTACHMENTS_PER_UPLOAD * MAX_ATTACHMENT_SIZE_BYTES;
    expect(ATTACHMENT_UPLOAD_MAX_BODY_BYTES).toBeLessThan(maxFileBytes * 2);
  });
});

describe('TICKET_JSON_MAX_BODY_BYTES', () => {
  // 添付が無いと分かっている経路に multipart と同じ枠を与えない (§9 最小権限・最小公開)。
  // 両者を 1 つの定数へ「統合」する退行をここで捕まえる
  it('添付付き経路の枠より大幅に小さい', () => {
    expect(TICKET_JSON_MAX_BODY_BYTES).toBeLessThan(ATTACHMENT_UPLOAD_MAX_BODY_BYTES);
  });

  // 本文 10,000 文字 (createTicketSchema の上限) を UTF-8 最長の 4 バイトで数えても収まる。
  // 枠を詰めすぎると、絵文字や漢字だけで長文を書いた正規の起票が 413 になる
  it('本文の文字数上限を 1 文字 4 バイトで数えても収まる', () => {
    // createTicketSchema が許す本文の最大文字数 (スキーマ側が唯一の源。ここは追随確認のための参照値)
    const maxBodyChars = 10_000;
    // UTF-8 の 1 文字あたり最大バイト数
    const worstCaseBytesPerChar = 4;
    expect(TICKET_JSON_MAX_BODY_BYTES).toBeGreaterThan(maxBodyChars * worstCaseBytesPerChar);
  });
});

describe('ATTACHMENT_UPLOAD_BODY_TOTAL_TIMEOUT_MS', () => {
  // 既定 (120 秒) を上書きする意味があること。ここが既定以下だと、51MB の枠に対して
  // 時間が足りず正規のアップロードが送信途中で打ち切られる (移行前からのデグレ)
  it('既定の全体期限より長い', () => {
    expect(ATTACHMENT_UPLOAD_BODY_TOTAL_TIMEOUT_MS).toBeGreaterThan(DEFAULT_BODY_TOTAL_TIMEOUT_MS);
  });

  // Node 既定の requestTimeout (300 秒) を超えるとサーバー側で先に切られ、こちらの
  // 打ち切り (だらだら送りの検知) が一度も効かなくなる
  it('Node 既定の requestTimeout (300 秒) より短い', () => {
    expect(ATTACHMENT_UPLOAD_BODY_TOTAL_TIMEOUT_MS).toBeLessThan(300_000);
  });

  // 無通信の上限より短いと、無通信の検知が一度も働かずに全体期限まで居座られる
  it('この経路が使う無通信の上限より長い', () => {
    expect(ATTACHMENT_UPLOAD_BODY_TOTAL_TIMEOUT_MS).toBeGreaterThan(
      STALL_TOLERANT_BODY_IDLE_TIMEOUT_MS,
    );
  });
});

// 2 つの表を同じ観点で回す (経路ごとに文言は違うが、満たすべき性質は同じ)
const TABLES = [
  ['チケット添付 (multipart)', TICKET_MULTIPART_BODY_REJECT_MESSAGES],
  ['チケット起票 (JSON)', TICKET_JSON_BODY_REJECT_MESSAGES],
] as const;

describe('チケット書き込み経路の拒否文言', () => {
  // timeout と unreadable はどちらも 400 なので、ステータスで文言を選ぶ実装では必ず同じ
  // 文字列になる。表が別々の文言を持っていることをまず押さえる
  it.each(TABLES)('%s: timeout と unreadable に別々の文言を持つ', (_name, messages) => {
    expect(messages.timeout).not.toBe(messages.unreadable);
  });

  // 表とヘルパーを実際につないで、理由ごとの文言がそのまま応答本文になることを確かめる
  it.each(TABLES)('%s: 各理由の文言がそのまま応答本文になる', async (name, messages) => {
    // console.warn を黙らせる (出力内容は body-reject-response.test.ts が受け持つ)
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 表が持つ理由をすべて回す (multipart は 4 つ、JSON は 3 つ)
    for (const [reason, message] of Object.entries(messages)) {
      // 'unparsable' だけは型が cause を要求するので添える (中身は表の検証に影響しない)
      const failure =
        reason === 'unparsable'
          ? ({ ok: false, reason, cause: new Error('x') } as const)
          : ({ ok: false, reason: reason as 'too-large' | 'timeout' | 'unreadable' } as const);
      // 2 つの表を 1 つのループで回すため、ここだけ型を広げて渡す
      // (本番の呼び出しは表と経路が 1 対 1 なので、型引数で理由の網羅が強制される)
      const res = bodyRejectResponse(failure as BodyRejectFailure, 1024, {
        logPrefix: `[${name}]`,
        messages: messages as BodyRejectMessages,
      });
      // 応答本文はその理由に割り当てた文言そのもの
      expect(await res.json()).toEqual({ error: message });
      // サイズ超過だけ 413、それ以外は 400
      expect(res.status).toBe(reason === 'too-large' ? 413 : 400);
    }
  });

  // JSON 経路は本文を読むだけでフォーム解析をしないので 'unparsable' は構造上起こらない
  // (到達しない文言を書かされていないことの表明)
  it('JSON 経路の表には unparsable が無い', () => {
    expect(TICKET_JSON_BODY_REJECT_MESSAGES).not.toHaveProperty('unparsable');
    // multipart を読む添付経路だけは持つ
    expect(TICKET_MULTIPART_BODY_REJECT_MESSAGES).toHaveProperty('unparsable');
  });

  // 「本文が届き切らなかった」2 理由は、利用者に伝えるべきことが経路で変わらないので
  // 2 つの表で同じ文言を共有する (共有の名前付き定数を両表が参照している)。
  // 片方だけ推敲されて同じ失敗理由に別の案内が出る退行をここで止める
  it('timeout と unreadable の文言は 2 つの表で一致する', () => {
    expect(TICKET_JSON_BODY_REJECT_MESSAGES.timeout).toBe(
      TICKET_MULTIPART_BODY_REJECT_MESSAGES.timeout,
    );
    expect(TICKET_JSON_BODY_REJECT_MESSAGES.unreadable).toBe(
      TICKET_MULTIPART_BODY_REJECT_MESSAGES.unreadable,
    );
  });

  // 一方で 'too-large' は経路ごとに変える (multipart は「添付を減らす」、JSON は「本文を短く」)。
  // 減らす対象が無い経路に添付の案内を出さないための区別で、上の共有とは意図が別
  it('too-large の文言は経路ごとに異なる', () => {
    expect(TICKET_JSON_BODY_REJECT_MESSAGES['too-large']).not.toBe(
      TICKET_MULTIPART_BODY_REJECT_MESSAGES['too-large'],
    );
  });

  // multipart の解析失敗の文言だけは移行前 (req.formData() の catch) と同じ文字列を保つ。
  // 利用者に見える文言・既存の E2E 期待値がずれないことの表明
  it('multipart の解析失敗の文言は移行前と同じ', () => {
    expect(TICKET_MULTIPART_BODY_REJECT_MESSAGES.unparsable).toBe(
      'リクエストの形式が正しくありません',
    );
  });
});
