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
//   (a)  SDK の申告するメジャー版が想定どおりか      … 破壊的変更の入口で落とす
//   (a') SDK 内部で版とメジャー版が整合しているか     … 申告どうしの食い違いを検出する
//   (b0) Stripe の生成箇所が src 全体で 1 つか        … 判定対象を一意に固定する
//   (b)  `apiVersion` に名前付き定数が渡されているか  … 指定の消失・無効化を検出する
//   (b') 配線された版が SDK の申告値と一致するか      … 別の値をキャストで渡す形を検出する
//   (c)  ソースに日付入りリテラルが復活していないか   … 手書きの写しへの逆戻りを防ぐ
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
//
// さらにパーサ化の初版にも、判定対象の取り方に起因する穴が残っていた (いずれも実測で確認):
//   - `new Stripe(...)` を 1 つに固定しておらず「最後に見つかった呼び出し」を見ていたため、
//     囮の 2 つ目を足せば本番のシングルトンから `apiVersion` が消えても (b) が通る。
//     別モジュールが古いメジャーへピン留めした 2 つ目のクライアントも素通りする → (b0) を追加
//   - 置換ありのテンプレートリテラル (`` `2026-07-29.${major}` ``) は断片が別ノードになるため、
//     接尾辞まで含む正規表現では取り落とす → 日付だけを見る形にし、断片も拾う
//   - ショートハンド (`{ apiVersion }`) を「指定なし」と誤判定していた → 受け付ける
//
// さらに「どこまでを走査対象と見るか」にも穴があった (いずれも実測で確認):
//   - 呼び出し元の名前を `Stripe` に決め打ちしていたため、別名のデフォルト import
//     (`import StripeSdk from 'stripe'`) で作った 2 つ目のクライアントが (b0) から見えない
//     → ファイルごとに `stripe` の束縛名を import 宣言から解決する
//   - (c) を 1 ファイルに絞っていたため、日付入りの写しを別モジュールへ置いて名前付き定数として
//     import し直すだけで (b)(c) を迂回できる → 走査を src 全体へ広げる
//     (src 全体で日付の文字列リテラルは 0 件なので、広げても誤検知は増えない)
//   - `apiVersion: undefined` は弾けても `const V = undefined` を経由すると素通りする
//
// この最後の 1 件は、当初「識別子の宣言まで辿って `undefined` への束縛を弾く」という静的解析で
// 塞ごうとしたが、**その方向は終わりのない綴り合わせになる**ことが分かった (`void 0`、
// 別名の 2 ホップ、同名定数によるファイル横断の誤解決…と、いずれも実測で素通りした)。
// しかも 1 つ漏らすたびに静かな fail-open が増える。
//
// **そこで「渡している値が実際に使えるものか」の判定は本番モジュール側の実行時チェック
// (`assertApiVersionSupported`) に移した。** 実行時の値を見るので綴りに依存せず、この系統の穴が
// まとめて閉じる。テスト側 (b) が担うのは「指定が書かれているか」だけ — こちらは SDK の既定値に
// 隠れて実行時からは見えないので、静的にしか確かめられない。役割を取り違えないこと。

// パスの組み立てと相対化 (走査範囲の指定と、違反箇所の読みやすい表示に使う)
import path from 'node:path';
// Vitest の DSL と前後処理
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// 構文木でソースを読むためのコンパイラ API (自前の字句解析をしないため)
import ts from 'typescript';
// 検査の基準となる SDK 本体 (API_VERSION / MAJOR_API_VERSION を読む)
import Stripe from 'stripe';
// 検査対象のモジュールが公開している、想定メジャー版とクライアント生成関数
import { EXPECTED_STRIPE_MAJOR_API_VERSION, getStripeClient } from '@/lib/stripe';
// src の走査と構文木化は検出網どうしで共有する (tests/entry-body-limit.test.ts と同じ土台)
import { parseSourceFiles, visitNodes } from './lib/source-module-graph';

// 検査対象のソースファイル (API バージョンを所有するモジュール)
const STRIPE_MODULE_PATH = path.resolve(__dirname, '../src/lib/stripe.ts');
// 走査範囲。**1 ファイルではなく src 全体**を見る (理由は下の (b0)(c) を参照)
const SRC_DIR = path.resolve(__dirname, '../src');

// 日付の形 (例: 2026-07-29)。(c) が使う。
// **`.<メジャー名>` まで含めず日付だけを見る**のが要点で、`` `2026-07-29.${major}` `` のように
// 分割して書かれた写しは「日付部分」しか 1 つのトークンに残らないため、接尾辞まで要求すると
// 取り落とす (実測でこの形が素通りしていた)。src 全体で日付の文字列リテラルは 0 件なので
// 範囲を広げても誤検知は増えない (実測して確認済み)
const DATED_VERSION_PATTERN = /\d{4}-\d{2}-\d{2}\./;

// 走査したソースの構文木。**1 回だけ読んで全テストで使い回す**
// (テストごとに読み直すと同じ I/O と解析を繰り返すうえ、走査中にファイルが書き換わると
//  テストごとに見ている対象がずれる。`tests/entry-body-limit.test.ts` と同じ方針)
const 走査済みソース = parseSourceFiles(SRC_DIR);

// `new Stripe(...)` を 1 件見つけた記録。構文木も持ち回るのは、`parseSourceFile` が
// `setParentNodes: false` で木を作るため、ノードから親 (SourceFile) を辿れないから
type Stripe生成箇所 = { パス: string; 呼び出し: ts.NewExpression; 木: ts.SourceFile };

/**
 * 1 ファイルの中で `stripe` の**デフォルト import に付けられた名前**を返す (無ければ null)。
 *
 * 名前を `Stripe` に決め打ちしないのは、デフォルト import の束縛名が任意だから。
 * 別名で import した 2 つ目のクライアント (`import StripeSdk from 'stripe'`) を
 * 見落とすと (b0) が素通りする (実測で確認済み)。
 * 型のみの import (`import type Stripe from 'stripe'`) は `new` できないので対象外にする。
 */
function stripeの束縛名(木: ts.SourceFile): string | null {
  // import 宣言はトップレベルの文にしか現れないので、木を全走査せず statements だけを見る
  for (const 文 of 木.statements) {
    if (!ts.isImportDeclaration(文)) continue;
    // 指定子が 'stripe' のものだけを見る
    if (!ts.isStringLiteral(文.moduleSpecifier) || 文.moduleSpecifier.text !== 'stripe') continue;
    // 型のみの import は実行時に存在しないので除く
    if (!文.importClause || 文.importClause.isTypeOnly) continue;
    // デフォルト import の名前を採る
    if (文.importClause.name) return 文.importClause.name.text;
  }
  return null;
}

/**
 * オブジェクトリテラルのプロパティ名を、引用符の有無によらず取り出す。
 *
 * `getText()` で比べると `{ 'apiVersion': V }` が `'apiVersion'` (引用符込み) になり、
 * 意味の変わらない書き換えで (b) が「指定なし」と誤判定してしまうため。
 */
function プロパティ名(名前: ts.PropertyName): string | null {
  // 識別子と文字列リテラルはどちらも `.text` が引用符を含まない名前になる
  if (ts.isIdentifier(名前) || ts.isStringLiteral(名前)) return 名前.text;
  // 計算プロパティなど静的に決まらない形は名前として扱わない
  return null;
}

/** `src/` 全体から `new <stripe のデフォルト import>(...)` の呼び出しを集める */
function Stripe生成箇所を集める(): Stripe生成箇所[] {
  // 見つけた呼び出しを入れる配列
  const 呼び出し群: Stripe生成箇所[] = [];
  // 走査済みの構文木を 1 つずつ見る
  for (const { path: パス, sourceFile: 木 } of 走査済みソース) {
    // このファイルが stripe をデフォルト import しているか (していなければ生成しえない)
    const 束縛名 = stripeの束縛名(木);
    if (束縛名 === null) continue;
    visitNodes(木, (node) => {
      // `new X(...)` の形で、かつ `X` がこのファイルでの stripe の束縛名のものだけを対象にする
      if (!ts.isNewExpression(node)) return;
      if (!ts.isIdentifier(node.expression) || node.expression.text !== 束縛名) return;
      呼び出し群.push({ パス, 呼び出し: node, 木 });
    });
  }
  return 呼び出し群;
}

// 生成箇所も 1 回だけ求めて使い回す ((b0) と (b) が同じものを見るようにする)
const Stripe生成箇所一覧 = Stripe生成箇所を集める();

// `apiVersion` の指定を調べた結果。どの理由で駄目だったかを呼び出し側が区別できるようにする
type apiVersion指定 =
  | { 種別: 'ok'; 識別子名: string } // 名前付き定数が渡されている (正常)
  | { 種別: '指定なし' } // オプション自体が無い / `apiVersion` が無い
  | { 種別: '不透明'; 詳細: string } // スプレッド等で静的に読めない
  | { 種別: '定数でない'; 詳細: string }; // リテラル・`undefined`・条件式など

/** ある `new Stripe(...)` 呼び出しの `apiVersion` 指定を構文木から読み取る */
function apiVersion指定を読む(呼び出し: ts.NewExpression, 木: ts.SourceFile): apiVersion指定 {
  // 第 2 引数 (オプション) を取り出す
  const 第2引数 = 呼び出し.arguments?.[1];
  // オプションを渡していなければ指定なし
  if (!第2引数) return { 種別: '指定なし' };
  // オブジェクトリテラル以外 (変数を渡す等) は静的に読めないので不透明として扱う
  if (!ts.isObjectLiteralExpression(第2引数))
    return {
      種別: '不透明',
      詳細: `オプションがオブジェクトリテラルでない: ${第2引数.getText(木)}`,
    };

  // `apiVersion` のプロパティを探す。**ショートハンド (`{ apiVersion }`) も受け付ける** —
  // 名前を変えただけのリファクタで赤くしないという方針の一部 (最も普通の書き換え形のため)
  for (const プロパティ of 第2引数.properties) {
    // 通常形 `apiVersion: 値`
    if (ts.isPropertyAssignment(プロパティ) && プロパティ名(プロパティ.name) === 'apiVersion') {
      const 値 = プロパティ.initializer;
      // 識別子でなければ (リテラル直書き・キャスト・条件式など) 名前付き定数ではない
      if (!ts.isIdentifier(値)) return { 種別: '定数でない', 詳細: 値.getText(木) };
      // `undefined` そのものは指定しないのと同義なので弾く
      if (値.text === 'undefined') return { 種別: '定数でない', 詳細: 'undefined' };
      return { 種別: 'ok', 識別子名: 値.text };
    }
    // ショートハンド形 `{ apiVersion }` (プロパティ名がそのまま定数名)
    if (
      ts.isShorthandPropertyAssignment(プロパティ) &&
      プロパティ名(プロパティ.name) === 'apiVersion'
    ) {
      return { 種別: 'ok', 識別子名: プロパティ.name.text };
    }
  }

  // `apiVersion` が見つからなかった。スプレッドがあるなら「無い」と断定できないので分けて報告する
  const スプレッド = 第2引数.properties.find(ts.isSpreadAssignment);
  if (スプレッド) return { 種別: '不透明', 詳細: `スプレッドで不透明: ${スプレッド.getText(木)}` };
  return { 種別: '指定なし' };
}

// `src` 全体の文字列リテラルから、日付の形をしたものを「ファイル: 中身」で集める ((c) が使う)。
//
// **走査を 1 ファイルに絞らない**のが要点。絞ると、日付入りの写しを別モジュールへ置いて
// 名前付き定数として import し直すだけで (b)(c) の両方を迂回できる (実測で確認済み)。
// (b') も、写した値が現時点では SDK の申告値と一致するため気付けず、次の bump ではじめて
// TS2322 で壊れる — この PR が無くそうとしている失敗そのものになる。
//
// **コメントはトークンではないので構文木に現れない** — 経緯の説明として日付版をコメントに
// 書いても誤検知しない (正規表現版で必要だったコメント除去が丸ごと不要になる)。
// テンプレートリテラルは置換の有無で節点の種類が変わるため、断片 (Head / Middle / Tail) まで拾う
// (`` `2026-07-29.${major}` `` のように分割した写しを取り落とさないため)
function 日付入りリテラルを集める(): string[] {
  // 見つけた違反を入れる配列
  const 違反: string[] = [];
  // 走査済みの構文木をたどって文字列らしきトークンをすべて見る
  for (const { path: パス, sourceFile: 木 } of 走査済みソース) {
    visitNodes(木, (node) => {
      if (
        !ts.isStringLiteral(node) &&
        !ts.isNoSubstitutionTemplateLiteral(node) &&
        !ts.isTemplateHead(node) &&
        !ts.isTemplateMiddle(node) &&
        !ts.isTemplateTail(node)
      )
        return;
      // 日付の形をしていれば、どこにあったかが分かる形で記録する
      if (DATED_VERSION_PATTERN.test(node.text))
        違反.push(`${path.relative(SRC_DIR, パス)}: ${node.text}`);
    });
  }
  return 違反;
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
  //     落ちたら「移行を確認してから定数を更新する」のが正しい対応。
  //
  //     **これは改ざん検知ではない。** 定数を新しいメジャー名へ書き換えれば当然また緑になり、
  //     それは「移行を済ませた」場合と「確認せず黙らせた」場合とで**まったく同じ編集**なので、
  //     テストの側から両者を区別することは原理的にできない。このガードの役目は
  //     「メジャーが変わったことを人の目に必ず一度通す」ことであって、その先の判断を強制する
  //     ことではない (強制したければレビューで差分の理由を確認する側に置くしかない)
  it('SDK が申告するメジャー API バージョンが想定どおりである', () => {
    expect(Stripe.MAJOR_API_VERSION).toBe(EXPECTED_STRIPE_MAJOR_API_VERSION);
  });

  // (a') SDK 内部の整合性を見る。`API_VERSION` と `MAJOR_API_VERSION` は別々の定数として
  //      公開されているため、上流の生成ミスで両者が食い違う (例: 版は `.basil` なのに
  //      メジャー申告は `dahlia`) と、(a) だけでは通ってしまう。
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
  // (b0) `new Stripe(...)` が src 全体で**ちょうど 1 箇所**であることを先に固定する。
  //      これが無いと (b) は「どれか 1 つの呼び出しに apiVersion があればよい」検査に退化し、
  //      本番のシングルトンから指定が消えても、別の呼び出しが持っていれば緑のまま通る。
  //      さらに、別モジュールが古いメジャーへピン留めした 2 つ目のクライアントを足しても
  //      気付けない。0 件 (検出網が対象を見失った) と 2 件以上の両方を fail-closed で落とす
  it('Stripe クライアントの生成箇所が src 全体でちょうど 1 つである', () => {
    // 生成箇所を src からの相対パスにして比較する
    // (行番号は入れない — 無関係な編集で行がずれるたびに赤くなるのは検査の意図ではない)
    const 箇所 = Stripe生成箇所一覧.map(({ パス }) => path.relative(SRC_DIR, パス));
    // 期待するのは API バージョンを所有するモジュールの 1 箇所だけ
    expect(箇所).toEqual([path.relative(SRC_DIR, STRIPE_MODULE_PATH)]);
  });

  // (b) 唯一の `new Stripe(...)` の `apiVersion` に**名前付き定数**が渡されていることを確かめる。
  //     SDK の既定値が `Stripe.API_VERSION` と同じなので、指定を消しても実行時の値は変わらない。
  //     「消えたこと」を検出できるのはソース側だけなので、ここは構文木を見る。
  //     定数名そのものは固定しない (名前を変えただけのリファクタで赤くしないため。
  //     値の正しさは (b') が担う)
  it('new Stripe(...) の apiVersion に名前付き定数を渡している', () => {
    // 生成箇所を取り出す ((b0) が 1 件であることを保証しているが、ここでも前提を確かめる)
    const 生成箇所 = Stripe生成箇所一覧;
    expect(生成箇所, 'new Stripe(...) の呼び出しをソースから特定できなかった').toHaveLength(1);
    // その呼び出しの apiVersion 指定を読む
    const 指定 = apiVersion指定を読む(生成箇所[0]!.呼び出し, 生成箇所[0]!.木);
    // 種別が ok 以外なら、理由をそのままメッセージに出して落とす
    expect(指定.種別, 指定.種別 === 'ok' ? '' : JSON.stringify(指定)).toBe('ok');
  });

  // (b') 指定した値が SDK の申告値と一致することを確かめる。
  //      キャストで別の日付版を渡す形 (`'...' as Stripe.LatestApiVersion`) はここで落ちる。
  //      指定の**消失**は上の (b) が担当する (この検査は SDK の既定値に隠れて検出できない)。
  //
  //      `getApiField` は SDK の型定義で `@private` とされ「将来削除しうる」と明記されている。
  //      それでも使うのは、**実際にクライアントへ配線された値**を読む手段が他に無いため
  //      (公開の定数どうしを比べるとトートロジーになる)。この結合は承知のうえで、SDK 更新で
  //      これが失われたら (b) と (c) が静的側の担保として残る、という前提で受け入れている
  it('配線された API バージョンが SDK の申告値と一致する', () => {
    expect(getStripeClient().getApiField('version')).toBe(Stripe.API_VERSION);
  });

  // (c) ソースに日付入りリテラルが復活していないことを確かめる。
  //     構文木から文字列リテラルだけを集めるので、コメント中の日付版は誤検知しない
  it('ソースに日付入りの API バージョンリテラルが直書きされていない', () => {
    // src 全体から日付入りの文字列リテラルを拾う (1 つも無いのが正常)
    expect(日付入りリテラルを集める()).toEqual([]);
  });
});
