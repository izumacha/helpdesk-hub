// ハイドレーション前のクリックに耐えるための共通ヘルパー。
//
// /code-review ultra 指摘対応 (計画書 §4.28.4): Next.js の Client Component は
// SSR された時点でボタンとして存在し、Playwright の操作可能判定も通る。
// しかし React のハイドレーションが済むまで onClick は結び付いていないので、
// その隙のクリックは「押せたのに何も起きない」で終わる。Playwright は
// **成功したクリックを再試行しない**ため、後続の待機がそのままタイムアウトする
// (CI の retries が flake として覆い隠すので、検出網としてはむしろ有害になる)。
//
// SSR された属性 (aria-expanded など) は初期 HTML にも同じ値で出るため
// 「ハイドレーション済みか」の合図には使えない。そこで合図に頼らず
// 「操作して、狙った結果になったか確かめる」を成立するまで繰り返す。
import { expect } from '@playwright/test';

// 1 回の試行で結果を待つ時間 (ミリ秒)。短くして、外れた試行を早く見切る
export const HYDRATION_ATTEMPT_MS = 5_000;

/**
 * `act` を実行し `verify` が通るまで、`budgetMs` の枠内で繰り返す。
 *
 * `act` は **何度実行しても安全** (冪等) でなければならない。
 * 例: 「閉じているときだけ押す」「毎回 goto からやり直す」など、
 * 途中まで成功した状態で再実行しても壊れない形にすること。
 *
 * @param act 実行する操作 (冪等であること)
 * @param verify 操作が効いたことを確かめる表明
 * @param budgetMs 再試行の総枠 (呼び出し側のテスト制限時間より十分小さいこと)
 */
export async function actUntil(
  act: () => Promise<void>,
  verify: () => Promise<void>,
  budgetMs: number,
): Promise<void> {
  // 操作と確認を 1 組にして、成立するまで再試行する
  await expect(async () => {
    // 操作を実行する (ハイドレーション前なら効かないことがある)
    await act();
    // 効いたかどうかを確かめる (通らなければこの試行は失敗し、もう一度 act から)
    await verify();
  }).toPass({ timeout: budgetMs });
}
