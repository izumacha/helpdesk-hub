// Stripe へ送る API バージョンの扱いを機械的に見張るガード。
//
// 背景 (なぜこのテストが要るのか):
//   以前 `src/lib/stripe.ts` は API バージョンを `'2026-07-29.dahlia'` のような日付入りリテラルで
//   **直書き**していた。ところが SDK の型 `Stripe.LatestApiVersion` は「その SDK が生成された
//   ただ 1 つの日付版」を指す単一のリテラル型なので、そもそも別の版を書くことは型が許さない。
//   つまり直書きは「版を固定する」働きを持たず、残っていた効果は
//   **stripe を上げるたびに typecheck だけが落ち、node_modules の中の値を人が書き写して直す**
//   という手間だけだった (実例: Dependabot の stripe 22.5.0 → 22.6.0 で TS2322)。
//
//   そこで値は SDK から導出する形に変えた。ただし導出にすると「日付が進んでも何も鳴らない」ので、
//   **本当に見張るべき破壊的変更＝メジャー版の切り替わり**を、ここで別途固定する。
//   Stripe の API バージョンは `<日付>.<メジャー名>` の形で、同じメジャー名のあいだは後方互換が
//   保たれる。日付だけの更新では鳴らず、メジャーが変わったときにだけ落ちるのが狙いどおりの挙動。
//
// 見張る対象は 5 つ:
//   (a)  SDK の申告するメジャー版が想定どおりか       … 破壊的変更の入口で落とす
//   (a') その想定値が実際の版の接尾辞と一致するか      … 定数を書き換えるだけの無力化を防ぐ
//   (b)  `apiVersion` の指定がソースに残っているか     … 指定そのものの消失を検出する
//   (b') 配線された版が SDK の申告値と一致するか       … 別の値をキャストで渡す形を検出する
//   (c)  ソースに日付入りリテラルが復活していないか    … 手書きの写しへの逆戻りを防ぐ
//
// (b) と (b') を分けている理由 (レビュー指摘で判明した罠):
//   SDK は `version: props.apiVersion || DEFAULT_API_VERSION` (stripe.core.js) と実装されていて、
//   **`DEFAULT_API_VERSION` は `Stripe.API_VERSION` そのもの**。つまり `apiVersion` の指定を
//   丸ごと消しても `getApiField('version')` は `Stripe.API_VERSION` を返し続けるので、
//   実行時の値を突き合わせるだけの検査は**指定の消失をひとつも検出できない**
//   (実測: 指定を削除しても 4 件すべて緑のままだった)。
//   そこで「指定が在ること」はソース側で (b)、「指定の値が正しいこと」は実行時に (b') で見る。
//   実行時の検査だけに寄せると、SDK の既定値に隠れて静かに fail-open する。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Stripe from 'stripe';
import { EXPECTED_STRIPE_MAJOR_API_VERSION, getStripeClient } from '@/lib/stripe';

// 検査対象のソースファイル (リテラル復活の検出に使う)
const STRIPE_MODULE_PATH = path.resolve(__dirname, '../src/lib/stripe.ts');

// Stripe の日付入り API バージョンの形 (例: 2026-07-29.dahlia)。
// (c) の検査でソース中にこの形が現れないことを確かめる
const DATED_API_VERSION_PATTERN = /\d{4}-\d{2}-\d{2}\.[a-z]+/;

// `src/lib/stripe.ts` から**コメントを除いたコード部分だけ**を取り出す ((b) と (c) が共用)。
//
// コメントを除くのは、経緯の説明として日付版がコメントに登場しうるため。行頭のコメントだけでなく
// **行末コメントも除く**必要がある (同ファイルは行末コメント形式を実際に使っており、
// 行頭だけ除く実装だと「コードは綺麗なのに赤くなる」誤検知になる)。
// `[^:]` を前置しているのは `https://…` の `//` をコメント開始と誤認しないため。
function コード部分を読む(): string {
  // ソースを読み込む
  const ソース = readFileSync(STRIPE_MODULE_PATH, 'utf8');
  // ブロックコメント → 行コメント (行頭・行末の両方) の順に取り除く
  const コード = ソース.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  // **検出網そのものが死んでいないかを、判定とは独立な手がかりで確かめる。**
  // コメント除去が効きすぎてコードまで消えると、呼び出し側の検査は「違反ゼロ＝緑」で
  // 無力化される。ここで落としておけば、その形の fail-open が起きない
  expect(コード).toContain('Stripe.API_VERSION');

  return コード;
}

// クライアント生成には STRIPE_SECRET_KEY が要る (未設定なら fail-closed で throw する仕様)。
// 実際の通信はしないのでダミー値でよい。テスト後に元へ戻す
const 元のシークレットキー = process.env.STRIPE_SECRET_KEY;

beforeAll(() => {
  // ダミーのシークレットキーを入れてクライアントを生成できるようにする
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy_for_api_version_guard';
  // シングルトンのキャッシュを捨て、このテストの環境変数で作り直させる
  global._stripeClient = undefined;
});

afterAll(() => {
  // 環境変数を元の状態へ戻す (未設定だったなら未設定に戻す)
  if (元のシークレットキー === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = 元のシークレットキー;
  // 生成したクライアントを捨てて他のテストへ持ち越さない
  global._stripeClient = undefined;
});

describe('Stripe API バージョンのガード', () => {
  // (a) 破壊的変更の入口。Stripe が次のメジャーへ進んだ SDK が入るとここで落ちる。
  //     落ちたら「移行して定数を更新する」のが正しい対応で、テストを緩めるのは誤り
  it('SDK が申告するメジャー API バージョンが想定どおりである', () => {
    expect(Stripe.MAJOR_API_VERSION).toBe(EXPECTED_STRIPE_MAJOR_API_VERSION);
  });

  // (a') 上の定数が「実際に使う版」と無関係な文字列になっていないことも確かめる。
  //      これが無いと、定数を適当な値へ書き換えるだけでガードを無力化できてしまう
  it('想定メジャー版が、実際に配線された API バージョンの接尾辞と一致する', () => {
    expect(getStripeClient().getApiField('version')).toMatch(
      new RegExp(`\\.${EXPECTED_STRIPE_MAJOR_API_VERSION}$`),
    );
  });

  // (b) `apiVersion` の指定そのものがソースに残っていることを確かめる。
  //     SDK の既定値が `Stripe.API_VERSION` と同じなので、指定を消しても実行時の値は変わらない。
  //     「消えたこと」を検出できるのはソース側だけなので、ここはソースを見る
  it('クライアント生成時に apiVersion を明示している', () => {
    expect(コード部分を読む()).toMatch(/apiVersion:\s*STRIPE_API_VERSION\b/);
  });

  // (b') 指定した値が SDK の申告値と一致することを確かめる。
  //      キャストで別の日付版を渡す形 (`'...' as Stripe.LatestApiVersion`) はここで落ちる。
  //      指定の**消失**は上の (b) が担当する (この検査は SDK の既定値に隠れて検出できない)
  it('配線された API バージョンが SDK の申告値と一致する', () => {
    expect(getStripeClient().getApiField('version')).toBe(Stripe.API_VERSION);
  });

  // (c) ソースに日付入りリテラルが復活していないことを確かめる。
  //     コメントには経緯の説明として日付版が登場しうるので、コメントを除いたコード部分だけを見る
  it('ソースに日付入りの API バージョンリテラルが直書きされていない', () => {
    expect(コード部分を読む()).not.toMatch(DATED_API_VERSION_PATTERN);
  });
});
