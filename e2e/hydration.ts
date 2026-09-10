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

/**
 * `act` を実行し `verify` が通るまで、`budgetMs` の枠内で繰り返す。
 *
 * `act` は **何度実行しても安全** (冪等) でなければならない。
 * 例: 「閉じているときだけ押す」「毎回 goto からやり直す」など、
 * 途中まで成功した状態で再実行しても壊れない形にすること。
 *
 * **`act` / `verify` の中身に上限を掛けるのは呼び出し側の責任**。この関数は
 * 全体の締切 (`budgetMs`) しか持たないので、内側に既定の上限が大きい操作
 * (`page.goto` の既定は 30 秒) を素で置くと、1 回目の試行だけで枠を使い切って
 * **再試行が 1 度も走らない**。呼び出し側は 1 回の試行に掛かる上限の合計が
 * `budgetMs` の半分以下に収まるよう、個別に `timeout` を渡すこと。
 *
 * @param act 実行する操作 (冪等であること。内側の待機に上限を渡すこと)
 * @param verify 操作が効いたことを確かめる表明 (同上)
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
