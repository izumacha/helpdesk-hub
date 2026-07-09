// SSO エンドポイント群 (acs/login/metadata) のレート制限テストで共有するアサーションヘルパー。
// /code-review ultra 指摘対応: 「上限回数までは 429 にならず、上限+1回目で 429 になる」という
// 同一の検証ループが 3 つのテストファイルに複製されていたため (CLAUDE.md §6
// 「2〜3 箇所目で共通化する」を超過)、ここに集約する。

import { expect } from 'vitest';

// makeRequest(i) を limit 回呼び出し、いずれも 429 でないことを確認したのち、
// もう 1 回呼び出して 429 になることを確認する
export async function expectRateLimitTripsAfter(
  makeRequest: (i: number) => Promise<Response>, // i 回目のリクエストを送る関数 (呼び出し元が引数の使い道を決める)
  limit: number, // この回数までは通っていいレート制限の上限
): Promise<void> {
  // 上限までは通常どおり (429 ではない) レスポンスが返るはず
  for (let i = 0; i < limit; i++) {
    const res = await makeRequest(i);
    expect(res.status).not.toBe(429);
  }
  // 上限+1回目は 429 になるはず
  const res = await makeRequest(limit);
  expect(res.status).toBe(429);
}
