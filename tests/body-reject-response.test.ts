// bodyRejectResponse のユニットテスト。
// このヘルパーを置いた理由は「拒否時の文言をステータスの 2 値ではなく拒否理由ごとに引く」ことなので、
// 同じ 400 に落ちる 3 つの理由がそれぞれ別の文言になることを中心に据える
// (`status === 413 ? A : B` の形に戻すと、その 3 件が同一文言になって落ちる)。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyRejectResponse } from '@/lib/body-reject-response';

// テスト用の文言表。4 つの理由すべてを別々の文字列にして取り違えを検出できるようにする
const MESSAGES = {
  'too-large': '大きすぎます',
  timeout: '途中で止まりました',
  unreadable: '読み取れませんでした',
  unparsable: '解析できませんでした',
} as const;

// テストで使う上限バイト数 (ログに載る値の確認に使う)
const MAX_BYTES = 1024;

// console.warn を差し替えて、ログに何が出たかを観測できるようにする。
// 復元は afterEach に任せる — ここで restore を呼ぶ形にすると、途中で例外が飛んだときに
// モックが残って後続テストの警告を飲み込んでしまう (vitest.config.ts は restoreMocks 未設定)
function captureWarn(): unknown[][] {
  const calls: unknown[][] = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    calls.push(args);
  });
  return calls;
}

afterEach(() => {
  // 差し替えたモックを必ず戻す (例外で抜けた場合も確実に実行される)
  vi.restoreAllMocks();
});

describe('bodyRejectResponse', () => {
  // 同じ 400 に落ちる 3 つの理由が、それぞれ別の文言で返ることを表明する
  it.each([
    ['too-large', 413, MESSAGES['too-large']],
    ['timeout', 400, MESSAGES.timeout],
    ['unreadable', 400, MESSAGES.unreadable],
    ['unparsable', 400, MESSAGES.unparsable],
  ] as const)('%s は %i と理由ごとの文言を返す', async (reason, status, message) => {
    captureWarn();
    const res = bodyRejectResponse(reason, MAX_BYTES, {
      logPrefix: '[test-route]',
      messages: MESSAGES,
    });
    // ステータスは bodyRejectStatus と一致する
    expect(res.status).toBe(status);
    // 本文はその理由に割り当てた文言 (ステータスではなく理由で引けている)
    expect(await res.json()).toEqual({ error: message });
  });

  // ログには理由の説明が出て、本文の中身は出ない (§9 PII をログに漏らさない)
  it('拒否理由をログ接頭辞つきで 1 行だけ出す', () => {
    const calls = captureWarn();
    bodyRejectResponse('too-large', MAX_BYTES, { logPrefix: '[test-route]', messages: MESSAGES });
    // 1 リクエストにつきログは 1 行だけ (呼び出し元との二重出力を防ぐ)
    expect(calls).toHaveLength(1);
    // 接頭辞と上限バイト数が読める形で出ている
    expect(String(calls[0]![0])).toContain('[test-route]');
    expect(String(calls[0]![0])).toContain(String(MAX_BYTES));
    // cause を渡していないので、余計な引数 ('undefined' の出力) は付かない
    expect(calls[0]).toHaveLength(1);
  });

  // 申告サイズを渡したときは、それがログ行に出る (413 の切り分けに使う唯一の数字)
  it('declaredLength を渡すと申告サイズがログ行に出る', () => {
    const calls = captureWarn();
    bodyRejectResponse('too-large', MAX_BYTES, {
      logPrefix: '[test-route]',
      messages: MESSAGES,
      declaredLength: 999_999,
    });
    expect(String(calls[0]![0])).toContain('999999');
  });

  // 申告が無い場合は、無いと分かる形で残す (数字をでっち上げない)
  it('declaredLength が無いときは申告が無い旨をログに残す', () => {
    const calls = captureWarn();
    bodyRejectResponse('too-large', MAX_BYTES, { logPrefix: '[test-route]', messages: MESSAGES });
    expect(String(calls[0]![0])).toContain('申告は無し');
  });

  // 解析失敗の原因を渡したときは、それもログに載せる (原因が分かるのはこの例外だけ)
  it('cause を渡すと原因の例外もログに載せる', () => {
    const cause = new Error('boundary が壊れています');
    const calls = captureWarn();
    bodyRejectResponse('unparsable', MAX_BYTES, {
      logPrefix: '[test-route]',
      messages: MESSAGES,
      cause,
    });
    // 説明文と原因の例外が同じ 1 行にまとまって出る
    expect(calls[0]).toHaveLength(2);
    expect(calls[0]![1]).toBe(cause);
  });
});
