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
// 見張る対象は 3 つ:
//   (a) SDK の申告するメジャー版が想定どおりか           … 破壊的変更の入口で落とす
//   (b) 実際にクライアントへ配線された版が SDK の申告値か … 「導出している」ことを配線ごと確かめる
//   (c) ソースに日付入りリテラルが復活していないか        … 手書きの写しへの逆戻りを防ぐ

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

  // (b) 「SDK から導出している」ことを、定数どうしの比較ではなく**実際の配線**で確かめる。
  //     手書きのリテラルへ戻すと SDK 更新のタイミングでここがずれる
  it('クライアントへ配線された API バージョンが SDK の申告値と一致する', () => {
    expect(getStripeClient().getApiField('version')).toBe(Stripe.API_VERSION);
  });

  // (c) ソースに日付入りリテラルが復活していないことを確かめる。
  //     コメントには経緯の説明として日付版が登場しうるので、コメントを除いたコード部分だけを見る
  it('ソースに日付入りの API バージョンリテラルが直書きされていない', () => {
    // ソースを読み、ブロックコメントと行コメントを取り除いてコード部分だけにする
    const ソース = readFileSync(STRIPE_MODULE_PATH, 'utf8');
    const コード = ソース.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // **検出網そのものが死んでいないかを先に確かめる** (§検出網は判定と独立な手がかりで見張る)。
    // コメント除去が効きすぎてコードまで消えると、以下の検査は「違反ゼロ＝緑」で無力化されるため
    expect(コード).toContain('Stripe.API_VERSION');

    // コード部分に日付入りリテラルが現れないこと (現れたら手書きの写しへ逆戻りしている)
    expect(コード).not.toMatch(DATED_API_VERSION_PATTERN);
  });
});
