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
// 見張る対象:
//   (a)  SDK の申告するメジャー版が想定どおりか    … 破壊的変更の入口で落とす
//   (a') SDK 内部で版とメジャー版が整合しているか   … 申告どうしの食い違いを検出する
//   (b)  `apiVersion` に名前付き定数が渡されているか … 指定の消失・無効化を検出する
//   (b') 配線された版が SDK の申告値と一致するか    … 別の値をキャストで渡す形を検出する
//   (c)  ソースに日付入りリテラルが復活していないか … 手書きの写しへの逆戻りを防ぐ
//
// (b) と (b') を分けている理由 (罠):
//   SDK は `version: props.apiVersion || DEFAULT_API_VERSION` (stripe.core.js) と実装されていて、
//   **`DEFAULT_API_VERSION` は `Stripe.API_VERSION` そのもの**。つまり `apiVersion` の指定を
//   丸ごと消しても `getApiField('version')` は `Stripe.API_VERSION` を返し続けるので、
//   実行時の値を突き合わせるだけの検査は**指定の消失をひとつも検出できない**
//   (実測: (b) を足す前の 4 件は、指定を削除しても全件緑のままだった)。
//   そこで「指定が在ること」はソース側で (b)、「指定の値が正しいこと」は実行時に (b') で見る。
//
// **ソースの読み取りは正規表現ではなく TypeScript のパーサで行う** (`tests/lib/source-module-graph.ts`
// を再利用。§6 DRY)。同ヘッダが書いているとおり、正規表現による検出網は「拾いすぎ」も「取り落とし」も
// **検査を緩める方向**に効く。実際、初版の正規表現版には次の穴があった (いずれも実測で確認):
//   - 行コメント中の `/*` と `*/` が 1 つのブロックコメントとして繋がり、その間の**実コードごと**
//     走査対象から消える → 日付リテラルを直書きしても (c) が緑のまま通る
//   - `apiVersion: undefined` を「名前付き定数」と誤認する → 指定を無効化しても (b) が通る
//   - ファイル全体を走査するため、`new Stripe(...)` から `apiVersion` を外しても、無関係な場所に
//     `apiVersion:` が 1 つあれば (b) が通る
// パーサならコメントはトークンにならず、判定を**実際の `new Stripe(...)` 引数に固定**できるので、
// これらの穴はまとめて消える (コメント除去も、その除去を見張る生存確認も不要になる)。

import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ts from 'typescript';
import Stripe from 'stripe';
import { EXPECTED_STRIPE_MAJOR_API_VERSION, getStripeClient } from '@/lib/stripe';
import { parseSourceFile, visitNodes } from './lib/source-module-graph';

// 検査対象のソースファイル
const STRIPE_MODULE_PATH = path.resolve(__dirname, '../src/lib/stripe.ts');

// Stripe の日付入り API バージョンの形 (例: 2026-07-29.dahlia)。(c) が使う
const DATED_API_VERSION_PATTERN = /\d{4}-\d{2}-\d{2}\.[a-z]+/;

// 構文木は 1 度だけ作って使い回す (同じファイルを何度も読み直さない)
const 構文木 = parseSourceFile(STRIPE_MODULE_PATH);

/**
 * `new Stripe(...)` の呼び出しに渡しているオプションから `apiVersion` の指定を取り出す。
 *
 * 見つからない場合は用途ごとに区別できるよう別々の値を返す:
 *   - 呼び出し自体が見つからない → `null` (検出網が対象を見失っている＝前提が崩れている)
 *   - 呼び出しはあるが `apiVersion` が無い → `undefined` (指定の消失＝(b) が検出すべき違反)
 */
function apiVersion指定を取り出す(): ts.Expression | null | undefined {
  // 見つけた `new Stripe(...)` のオプション引数を入れる場所
  let オプション: ts.ObjectLiteralExpression | null = null;
  // 呼び出し自体を見つけたかどうか (オプションを渡していない形と区別するために持つ)
  let 呼び出しを見つけた = false;

  // 構文木をたどって `new Stripe(...)` を探す
  visitNodes(構文木, (node) => {
    // `new X(...)` の形で、かつ `X` が識別子 `Stripe` のものだけを対象にする
    if (!ts.isNewExpression(node)) return;
    if (!ts.isIdentifier(node.expression) || node.expression.text !== 'Stripe') return;
    // 呼び出しは見つかった (この時点でオプションの有無は問わない)
    呼び出しを見つけた = true;
    // 第 2 引数がオブジェクトリテラルなら、それがオプション
    const 第2引数 = node.arguments?.[1];
    if (第2引数 && ts.isObjectLiteralExpression(第2引数)) オプション = 第2引数;
  });

  // 呼び出しが 1 つも無いなら、検出網が対象を見失っている
  if (!呼び出しを見つけた) return null;
  // 呼び出しはあるがオプションを渡していない = `apiVersion` の指定が無い
  if (オプション === null) return undefined;

  // オプションの中から `apiVersion: ...` のプロパティを探す
  const プロパティ = (オプション as ts.ObjectLiteralExpression).properties.find(
    (p): p is ts.PropertyAssignment =>
      ts.isPropertyAssignment(p) && p.name.getText(構文木) === 'apiVersion',
  );
  // 見つからなければ指定なし、見つかればその値の式を返す
  return プロパティ?.initializer;
}

// モジュール内に書かれた文字列リテラルをすべて集める ((c) が使う)。
// **コメントはトークンではないので構文木に現れない** — 経緯の説明として日付版をコメントに
// 書いても誤検知しない (正規表現版で必要だったコメント除去が丸ごと不要になる)
function 文字列リテラルを集める(): string[] {
  // 集めた文字列を入れる配列
  const 文字列群: string[] = [];
  // 構文木をたどって文字列リテラル (通常の引用符とテンプレートの両方) を拾う
  visitNodes(構文木, (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      文字列群.push(node.text);
    }
  });
  return 文字列群;
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
  //     落ちたら「移行して定数を更新する」のが正しい対応で、テストを緩めるのは誤り。
  //     定数を書き換えてガードを黙らせようとした場合もここが落ちる
  it('SDK が申告するメジャー API バージョンが想定どおりである', () => {
    expect(Stripe.MAJOR_API_VERSION).toBe(EXPECTED_STRIPE_MAJOR_API_VERSION);
  });

  // (a') SDK 内部の整合性を見る。`API_VERSION` と `MAJOR_API_VERSION` は別々の定数として
  //      公開されているため、上流の生成ミスで両者が食い違う (例: 版は `.basil` なのに
  //      メジャー申告は `dahlia`) と、(a) だけでは通ってしまう。
  //      **定数の書き換えを検出する役目は (a) が負っている** — こちらではない。
  //      比較は正規表現ではなく `endsWith` で行う (メジャー名に `.` や `(` のような正規表現の
  //      特殊文字が入ったとき、誤って通す / 例外で落ちる のどちらも避けるため)
  it('SDK の API バージョンとメジャー版の申告が互いに整合している', () => {
    expect(Stripe.API_VERSION.endsWith(`.${Stripe.MAJOR_API_VERSION}`)).toBe(true);
  });

  // (b) `apiVersion` に**名前付き定数**が渡されていることを、実際の `new Stripe(...)` 引数で確かめる。
  //     SDK の既定値が `Stripe.API_VERSION` と同じなので、指定を消しても実行時の値は変わらない。
  //     「消えたこと」を検出できるのはソース側だけなので、ここは構文木を見る。
  //     定数名そのものは固定しない (名前を変えただけのリファクタで赤くしないため。
  //     値の正しさは (b') が担う)
  it('new Stripe(...) の apiVersion に名前付き定数を渡している', () => {
    // 指定を取り出す (null なら呼び出しを見失っている＝前提が崩れているので、それも落とす)
    const 指定 = apiVersion指定を取り出す();
    // 呼び出しを見失っていないこと (検出網が対象を捉えていることの確認)
    expect(指定, 'new Stripe(...) の呼び出しをソースから特定できなかった').not.toBeNull();
    // 指定が消えていないこと
    expect(指定, 'apiVersion の指定が無い').not.toBeUndefined();
    // 値が識別子 (名前付き定数) であること。
    // リテラル直書き・`undefined`・条件式などはここで落ちる
    // (`undefined` は識別子だが値を渡さないのと同義なので、名前で明示的に弾く)
    const 識別子か = 指定 != null && ts.isIdentifier(指定) && 指定.text !== 'undefined';
    expect(識別子か, `apiVersion に名前付き定数以外が渡されている: ${指定?.getText(構文木)}`).toBe(
      true,
    );
  });

  // (b') 指定した値が SDK の申告値と一致することを確かめる。
  //      キャストで別の日付版を渡す形 (`'...' as Stripe.LatestApiVersion`) はここで落ちる。
  //      指定の**消失**は上の (b) が担当する (この検査は SDK の既定値に隠れて検出できない)
  it('配線された API バージョンが SDK の申告値と一致する', () => {
    expect(getStripeClient().getApiField('version')).toBe(Stripe.API_VERSION);
  });

  // (c) ソースに日付入りリテラルが復活していないことを確かめる。
  //     構文木から文字列リテラルだけを集めるので、コメント中の日付版は誤検知しない
  it('ソースに日付入りの API バージョンリテラルが直書きされていない', () => {
    // 日付入りの形に一致する文字列リテラルを拾う
    const 違反 = 文字列リテラルを集める().filter((s) => DATED_API_VERSION_PATTERN.test(s));
    // 1 つも無いこと (あれば手書きの写しへ逆戻りしている)
    expect(違反).toEqual([]);
  });
});
