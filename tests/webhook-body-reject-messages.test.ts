// 受信 Webhook 3 経路の「拒否理由 → クライアントへ返す文言」の表を、本番の表そのもので固定する。
//
// なぜルート経由のテストでは足りないか:
// 「理由ごとに文言を引く」実装をステータスの 2 値で選ぶ形へ戻す退行は、`too-large` (413) と
// `unparsable` (400) だけを見ても検出できない — どちらの実装でも同じ文字列が出るため。
// 実際に差が出るのは `timeout` の文言だけで、これをルート越しに発火させるには実時間で
// 無通信タイムアウトを待つ必要があり、テストが数十秒単位で重くなる。
// そこで表を route の外へ出し (`src/lib/webhook-body-reject-messages.ts`)、表そのものと
// ヘルパーの組み合わせでここに表明する。

import { describe, expect, it, vi, afterEach } from 'vitest';
import { bodyRejectResponse } from '@/lib/body-reject-response';
import type { BodyRejectFailure, BodyRejectMessages } from '@/lib/request-body-limit';
import {
  LINE_BODY_REJECT_MESSAGES,
  INBOUND_EMAIL_BODY_REJECT_MESSAGES,
  STRIPE_BODY_REJECT_MESSAGES,
} from '@/lib/webhook-body-reject-messages';

afterEach(() => {
  // bodyRejectResponse は console.warn を出すので、差し替えたモックを毎回戻す
  vi.restoreAllMocks();
});

// 3 つの表を同じ観点で回す (経路ごとに文言は違うが、満たすべき性質は同じ)
const TABLES = [
  ['LINE 取り込み', LINE_BODY_REJECT_MESSAGES],
  ['メール取り込み', INBOUND_EMAIL_BODY_REJECT_MESSAGES],
  ['Stripe 課金', STRIPE_BODY_REJECT_MESSAGES],
] as const;

describe('受信 Webhook の拒否文言', () => {
  // 表の側の前提: timeout と unreadable はどちらも 400 なので、ステータスで文言を選ぶ実装では
  // 必ず同じ文字列になる。まず表が別々の文言を持っていることを押さえる。
  // (この 1 件は表だけを見るのでヘルパーの実装には反応しない。退行を捕まえるのは下の
  //  「各理由の文言がそのまま応答本文になる」の方 — 退行を注入して実際に確認済み)
  it.each(TABLES)('%s: timeout と unreadable に別々の文言を持つ', (_name, messages) => {
    expect(messages.timeout).not.toBe(messages.unreadable);
  });

  // 表とヘルパーを実際につないで、理由ごとの文言がそのまま応答本文になることを確かめる。
  // ここが通れば「表に別々の文言がある」だけでなく「引く側も理由で引いている」ことが言える
  it.each(TABLES)('%s: 各理由の文言がそのまま応答本文になる', async (name, messages) => {
    // console.warn を黙らせる (出力内容は body-reject-response.test.ts が受け持つ)
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 表が持つ理由をすべて回す (経路によって 3 つ or 4 つ)
    for (const [reason, message] of Object.entries(messages)) {
      // 'unparsable' だけは型が cause を要求するので添える (中身は表の検証に影響しない)
      const failure =
        reason === 'unparsable'
          ? ({ ok: false, reason, cause: new Error('x') } as const)
          : ({ ok: false, reason: reason as 'too-large' | 'timeout' | 'unreadable' } as const);
      // 3 つの表を 1 つのループで回すため、ここだけ型を広げて渡す。
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

  // 本文を読むだけの 2 経路は 'unparsable' が構造上起こらないので、表にも持たせない
  // (到達しない文言を書かされていないことの表明)
  it('本文を読むだけの経路の表には unparsable が無い', () => {
    expect(LINE_BODY_REJECT_MESSAGES).not.toHaveProperty('unparsable');
    expect(STRIPE_BODY_REJECT_MESSAGES).not.toHaveProperty('unparsable');
    // multipart を読むメール取り込みだけは持つ
    expect(INBOUND_EMAIL_BODY_REJECT_MESSAGES).toHaveProperty('unparsable');
  });
});
