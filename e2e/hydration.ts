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
 * 「1 回の試行の上限の合計が枠の半分以下」を**モジュール読み込み時に機械的に確かめる**。
 *
 * この条件は下の docstring が求めているものだが、書いてあるだけでは守られない
 * (実際に login.ts が自分で破っていた)。上限を 1 つ足したり枠を縮めたりしたときに
 * 気付けるよう、条件そのものをコードにする。**Playwright の既定の操作上限は無制限**
 * (`actionTimeout` の既定は 0) なので、上限を渡していない操作があると合計は
 * 事実上「無限」になる — 呼び出し側は待ちうる操作すべてに上限を渡すこと。
 *
 * @param label 失敗メッセージに出す呼び出し側の名前
 * @param attemptMs 1 回の試行で使いうる上限の合計 (ミリ秒)
 * @param budgetMs 再試行の総枠 (ミリ秒)
 */
export function assertAttemptFitsBudget(label: string, attemptMs: number, budgetMs: number): void {
  // 合計が枠の半分を超えていたら、2 回目の試行が始まらない可能性がある
  if (attemptMs * 2 > budgetMs) {
    // 実行前に落として、原因の分からない「Test timeout」に化けるのを防ぐ
    throw new Error(
      `${label}: 1 回の試行の上限の合計 ${attemptMs}ms が枠 ${budgetMs}ms の半分を超えています。` +
        '上限を縮めるか枠を広げてください (枠はテストの制限時間より小さいこと)。',
    );
  }
}

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
