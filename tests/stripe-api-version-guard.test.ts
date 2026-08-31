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
//   **本当に見張るべき破壊的変更＝メジャー版の切り替わり**を別途固定する。
//   Stripe の API バージョンは `<日付>.<メジャー名>` の形で、同じメジャー名のあいだは後方互換が
//   保たれる。日付だけの更新では鳴らず、メジャーが変わったときにだけ落ちるのが狙いどおりの挙動。
//
// **役割分担 (ここが一番大事)**:
//   「渡している値が実際に使えるものか」は**本番モジュール側の実行時チェック**
//   (`assertApiVersionSupported`) が担う。しかも検査対象は定数ではなく
//   **実際に `new Stripe(...)` へ渡すオプションオブジェクト**なので、別の定数に差し替えられても、
//   後ろのスプレッドで上書きされても、指定ごと消されても、その結果を見て落ちる。
//
//   これを静的解析でやろうとすると終わりのない綴り合わせになる。実際に `undefined` /
//   `void 0` / 別名の 2 ホップ / 同名定数によるファイル横断の誤解決 と順に塞いだが、
//   いずれも「1 つ漏らすたびに静かな fail-open が増える」形だった。実行時の値を見る方式は
//   綴りに依存しないので、この系統がまとめて閉じる。
//
//   このテストが担うのは、実行時チェックでは原理的に見えない**静的な性質**:
//     (a)  SDK の申告するメジャー版が想定どおりか    … 破壊的変更の入口で落とす
//     (a') SDK 内部で版とメジャー版が整合しているか   … 申告どうしの食い違いを検出する
//     (b0') stripe を実行時に import するファイルが 1 つか … SDK に触れる範囲を閉じ込める
//     (b0) Stripe の生成箇所が src 全体で 1 つか      … 生成箇所の増殖を検出する
//     (b)  実行時チェックが生成経路に配線されているか … 検査ごと外されるのを防ぐ
//     (b') 配線された版が SDK の申告値と一致するか    … 実行時チェックごと通ることを確かめる
//     (c)  日付入りリテラルが復活していないか         … 手書きの写しへの逆戻りを防ぐ
//
//   (b0')(b0) は実行時チェックの守備範囲外。**2 つ目のクライアント**は
//   `getStripeClient()` を通らないので、いくら実行時チェックを強くしても見えない。
//   2 つを併せ持つのは守備範囲が違うため: (b0) は「どう import したか」を解決してから `new` を
//   探すので束縛が別モジュール経由で渡る形に弱く、(b0') は「SDK がどのファイルへ到達しているか」
//   だけを見るので再エクスポート・`import = require`・動的 import もまとめて捉える (実測で確認)。
//
// **ソースの読み取りは正規表現ではなく TypeScript のパーサで行う**
// (`tests/lib/source-module-graph.ts` を再利用。§6 DRY)。同ヘッダが書いているとおり、
// 正規表現による検出網は「拾いすぎ」も「取り落とし」も**検査を緩める方向**に効く。
// 実際、初版の正規表現版はコメント中の `/*` `*/` の断片が繋がって実コードごと走査対象から
// 消えており、日付リテラルを直書きしても緑のまま通っていた。

// パスの組み立てと相対化 (違反箇所を読みやすく表示するために使う)
import path from 'node:path';
// Vitest の DSL と前後処理
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// 構文木でソースを読むためのコンパイラ API (自前の字句解析をしないため)
import ts from 'typescript';
// 検査の基準となる SDK 本体 (API_VERSION / MAJOR_API_VERSION を読む)
import Stripe from 'stripe';
// 検査対象のモジュールが公開している、想定メジャー版とクライアント生成関数
import { EXPECTED_STRIPE_MAJOR_API_VERSION, getStripeClient } from '@/lib/stripe';
// src の走査範囲・構文木化は検出網どうしで共有する (tests/entry-body-limit.test.ts と同じ土台)
import { SRC_DIR, parseSourceFiles, visitNodes } from './lib/source-module-graph';

// API バージョンを所有するモジュール ((b0) が「生成箇所はここ 1 つ」と突き合わせる)
const STRIPE_MODULE_PATH = path.join(SRC_DIR, 'lib', 'stripe.ts');

// 日付入りバージョンの形 (例: 2026-07-29.dahlia)。(c) が使う。
//
// **日付の直後にドットを要求する**のが要点。ドットを外して日付だけを見ると、
// `min="2026-01-01"` のような**無関係な日付文字列**まで Stripe のテストで赤くなる
// (日付入力や CSV の見本など、src に入る現実的な理由がある)。無関係なコードを巻き込む検出網は
// いずれ緩められるので、精度の側に寄せる。ドットを要求してもテンプレートの断片
// (`` `2026-07-29.${major}` `` の Head = "2026-07-29.") は拾える。
//
// 残る取りこぼし: `'2026-07-29'` と `'.' + major` のようにドットの手前で**トークンを割った**写しは
// 検出できない。これは誤って書ける形ではなく意図的に分割した場合だけなので、上の誤検知リスクと
// 引き換えに受け入れている (値が使えるかどうかは実行時チェックが別に見ている)。
const DATED_VERSION_PATTERN = /\d{4}-\d{2}-\d{2}\./;

// 本番モジュール側の実行時チェックの関数名 ((b) がこの呼び出しの存在を確かめる)
const RUNTIME_ASSERT_NAME = 'assertApiVersionSupported';

// 走査したソースの構文木。**1 回だけ読んで全テストで使い回す**
// (テストごとに読み直すと同じ I/O と解析を繰り返すうえ、走査中にファイルが書き換わると
//  テストごとに見ている対象がずれる。`tests/entry-body-limit.test.ts` と同じ方針)
const parsedSources = parseSourceFiles();

// `new Stripe(...)` を 1 件見つけた記録。構文木も持ち回るのは、`parseSourceFile` が
// `setParentNodes: false` で木を作るため、ノードから親 (SourceFile) を辿れないから
type StripeConstruction = { path: string; call: ts.NewExpression; sourceFile: ts.SourceFile };

/**
 * 1 ファイルの中で `stripe` を実行時に参照できる**束縛名**を集める。
 *
 * 名前を `Stripe` に決め打ちしないのは、import の束縛名が任意だから。
 * 名前空間 import (`import * as Ns from 'stripe'` → `new Ns.default(...)`) も対象にするのは、
 * デフォルト import だけを見ていた版が実測でこの形を素通りさせたため。
 * 型のみの import (`import type Stripe from 'stripe'`) は `new` できないので除く。
 */
function collectStripeBindings(sourceFile: ts.SourceFile): {
  defaultNames: string[];
  namespaceNames: string[];
} {
  // デフォルト import の束縛名 (`new <名前>(...)` の形で使われる)
  const defaultNames: string[] = [];
  // 名前空間 import の束縛名 (`new <名前>.default(...)` の形で使われる)
  const namespaceNames: string[] = [];
  // import 宣言はトップレベルの文にしか現れないので、木を全走査せず statements だけを見る
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    // 指定子が 'stripe' のものだけを見る
    if (
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== 'stripe'
    )
      continue;
    // 型のみの import は実行時に存在しないので除く
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    // デフォルト import の名前
    if (clause.name) defaultNames.push(clause.name.text);
    // 名前空間 import の名前
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))
      namespaceNames.push(clause.namedBindings.name.text);
    // 名前付き import の名前。stripe はクラスを default と名前付き (`Stripe`) の両方で公開しており、
    // `import { Stripe } from 'stripe'` でも同じクラスが手に入る。ここを見ないと、その形で作った
    // 2 つ目のクライアントが (b0) から見えない (実測で素通りした)
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        // 要素ごとの型のみ import (`import { type Stripe }`) は実行時に存在しないので除く
        if (element.isTypeOnly) continue;
        // 元の名前 (別名なら propertyName 側) が Stripe クラスを指すものだけを拾う
        const imported = (element.propertyName ?? element.name).text;
        if (imported === 'Stripe' || imported === 'default') defaultNames.push(element.name.text);
      }
    }
  }
  return { defaultNames, namespaceNames };
}

/** その `new` 式が Stripe クライアントの生成かどうかを、束縛名と突き合わせて判定する */
function isStripeConstruction(
  call: ts.NewExpression,
  bindings: { defaultNames: string[]; namespaceNames: string[] },
): boolean {
  // `new <デフォルト束縛名>(...)` の形
  if (ts.isIdentifier(call.expression)) return bindings.defaultNames.includes(call.expression.text);
  // `new <名前空間束縛名>.default(...)` の形
  if (ts.isPropertyAccessExpression(call.expression) && ts.isIdentifier(call.expression.expression))
    return bindings.namespaceNames.includes(call.expression.expression.text);
  return false;
}

/**
 * `stripe` モジュールを**実行時に**引き込んでいるファイルを集める。
 *
 * なぜ生成箇所の走査だけでは足りないか: 生成箇所の検出は「そのファイルが `stripe` を
 * どの名前で import したか」を解決してから `new` を探すので、**束縛が別モジュール経由で
 * 渡ってくる形**が見えない (`export { default as X } from 'stripe'` を別ファイルが import して
 * `new X(...)` する、など。実測で素通りした)。`import x = require('stripe')` や
 * `await import('stripe')` も同様。
 *
 * そこで「SDK に触れられるのはどのファイルか」を別に固定する。**クライアントを作るには
 * 何らかの経路で `stripe` がそのモジュールへ到達している必要がある**ので、到達点の集合を
 * 1 ファイルに閉じ込めれば、上のような間接的な形もまとめて塞げる (構成上の性質なので、
 * 新しい書き方が増えても崩れない)。
 *
 * 型のみの参照は実行時に消えるので数えない (Webhook ルートの `import type Stripe from 'stripe'`
 * は正当な利用)。
 */
function collectRuntimeStripeImporters(): string[] {
  // 見つけたファイルのパスを入れる配列
  const importers: string[] = [];
  // 走査済みの構文木を 1 つずつ見る
  for (const { path: filePath, sourceFile } of parsedSources) {
    // このファイルが実行時に stripe を引き込んでいるか
    let referencesAtRuntime = false;
    visitNodes(sourceFile, (node) => {
      // `import ... from 'stripe'` / `export ... from 'stripe'` (型のみは除く)
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const specifier = node.moduleSpecifier;
        if (!specifier || !ts.isStringLiteral(specifier) || specifier.text !== 'stripe') return;
        // 宣言まるごと型のみなら実行時には残らない
        if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) return;
        if (ts.isExportDeclaration(node) && node.isTypeOnly) return;
        referencesAtRuntime = true;
        return;
      }
      // `import x = require('stripe')`
      if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        const expression = node.moduleReference.expression;
        if (ts.isStringLiteral(expression) && expression.text === 'stripe')
          referencesAtRuntime = true;
        return;
      }
      // `import('stripe')` (動的 import)
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length > 0 &&
        ts.isStringLiteral(node.arguments[0]!) &&
        node.arguments[0].text === 'stripe'
      ) {
        referencesAtRuntime = true;
      }
    });
    if (referencesAtRuntime) importers.push(path.relative(SRC_DIR, filePath));
  }
  return importers;
}

/** `src/` 全体から Stripe クライアントの生成箇所を集める */
function collectStripeConstructions(): StripeConstruction[] {
  // 見つけた呼び出しを入れる配列
  const constructions: StripeConstruction[] = [];
  // 走査済みの構文木を 1 つずつ見る
  for (const { path: filePath, sourceFile } of parsedSources) {
    // このファイルが stripe を実行時に import しているか (していなければ生成しえない)
    const bindings = collectStripeBindings(sourceFile);
    if (bindings.defaultNames.length === 0 && bindings.namespaceNames.length === 0) continue;
    visitNodes(sourceFile, (node) => {
      // Stripe クライアントの生成に当たる `new` 式だけを拾う
      if (!ts.isNewExpression(node)) return;
      if (!isStripeConstruction(node, bindings)) return;
      constructions.push({ path: filePath, call: node, sourceFile });
    });
  }
  return constructions;
}

// 生成箇所も 1 回だけ求めて使い回す ((b0) と (b) が同じものを見るようにする)
const stripeConstructions = collectStripeConstructions();

/** `src` 全体の文字列リテラルから、日付入りバージョンの形をしたものを集める */
function collectDatedVersionLiterals(): string[] {
  // 見つけた違反を「ファイル: 中身」で入れる配列
  const violations: string[] = [];
  // 走査済みの構文木をたどって文字列らしきトークンをすべて見る。
  // **コメントはトークンではないので構文木に現れない** — 経緯の説明として日付版をコメントに
  // 書いても誤検知しない。テンプレートリテラルは置換の有無で節点の種類が変わるため断片まで拾う
  for (const { path: filePath, sourceFile } of parsedSources) {
    visitNodes(sourceFile, (node) => {
      if (
        !ts.isStringLiteral(node) &&
        !ts.isNoSubstitutionTemplateLiteral(node) &&
        !ts.isTemplateHead(node) &&
        !ts.isTemplateMiddle(node) &&
        !ts.isTemplateTail(node)
      )
        return;
      // 日付入りバージョンの形をしていれば、どこにあったかが分かる形で記録する
      if (DATED_VERSION_PATTERN.test(node.text))
        violations.push(`${path.relative(SRC_DIR, filePath)}: ${node.text}`);
    });
  }
  return violations;
}

// クライアント生成には STRIPE_SECRET_KEY が要る (未設定なら fail-closed で throw する仕様)。
// 実際の通信はしないのでダミー値でよい。テスト後に元へ戻す
const originalSecretKey = process.env.STRIPE_SECRET_KEY;

beforeAll(() => {
  // ダミーのシークレットキーを入れてクライアントを生成できるようにする
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy_for_api_version_guard';
  // シングルトンのキャッシュを捨て、このテストの環境変数で作り直させる
  global._stripeClient = undefined;
});

afterAll(() => {
  // 環境変数を元の状態へ戻す (未設定だったなら未設定に戻す)
  if (originalSecretKey === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = originalSecretKey;
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

  // (b0) Stripe クライアントの生成箇所が src 全体でちょうど 1 つであることを固定する。
  //      **実行時チェックの守備範囲外**なのでここで見る — 2 つ目のクライアントは
  //      `getStripeClient()` を通らないため、いくら実行時チェックを強くしても見えない。
  //      古いメジャーへピン留めした 2 つ目が黙って入るのを防ぐ。
  //      0 件 (検出網が対象を見失った) と 2 件以上の両方を fail-closed で落とす
  // (b0') SDK に実行時に触れられるファイルを 1 つに閉じ込める。
  //       生成箇所の走査は「そのファイルが stripe をどの名前で import したか」を解決してから
  //       `new` を探すため、束縛が別モジュール経由で渡ってくる形 (再エクスポート・
  //       `import = require` ・動的 import) が見えない。**クライアントを作るには何らかの経路で
  //       stripe がそのモジュールへ到達している必要がある**ので、到達点を固定すればまとめて塞げる
  it('stripe を実行時に import しているファイルが 1 つだけである', () => {
    expect(collectRuntimeStripeImporters()).toEqual([path.relative(SRC_DIR, STRIPE_MODULE_PATH)]);
  });

  it('Stripe クライアントの生成箇所が src 全体でちょうど 1 つである', () => {
    // 生成箇所を src からの相対パスにして比較する
    // (行番号は入れない — 無関係な編集で行がずれるたびに赤くなるのは検査の意図ではない)
    const locations = stripeConstructions.map(({ path: p }) => path.relative(SRC_DIR, p));
    // 期待するのは API バージョンを所有するモジュールの 1 箇所だけ
    expect(locations).toEqual([path.relative(SRC_DIR, STRIPE_MODULE_PATH)]);
  });

  // (b) **実行時チェックがクライアント生成の経路に配線されている**ことを確かめる。
  //     値の妥当性そのものは実行時チェックが見るので、ここが見るのは「その呼び出しが在るか」だけ。
  //     値を静的に追いかけない (綴り違いを延々と塞ぐ作業になり、漏らすたびに fail-open が増える)。
  //     呼び出しを消すと ESLint は「未使用」と言うが **warning 止まりで CI は緑のまま**通るため、
  //     ここで落とす必要がある
  it('API バージョンの実行時チェックがクライアント生成の経路に配線されている', () => {
    // 生成箇所を取り出す ((b0) が 1 件であることを保証しているが、ここでも前提を確かめる)
    expect(stripeConstructions, '生成箇所をソースから特定できなかった').toHaveLength(1);
    // 生成箇所と同じモジュールから、実行時チェックの呼び出しを探す
    const calls: string[] = [];
    visitNodes(stripeConstructions[0]!.sourceFile, (node) => {
      if (!ts.isCallExpression(node)) return;
      if (ts.isIdentifier(node.expression) && node.expression.text === RUNTIME_ASSERT_NAME)
        calls.push(node.getText(stripeConstructions[0]!.sourceFile));
    });
    // 1 回以上呼ばれていること (消えていたら実行時の担保ごと失われている)。
    // 見つかった呼び出しをメッセージに載せる (増えた・形が変わったときに差分が読める)
    expect(
      calls.length,
      `${RUNTIME_ASSERT_NAME} の呼び出しが見つからない (検出したもの: ${JSON.stringify(calls)})`,
    ).toBeGreaterThan(0);
  });

  // (b') クライアントを実際に生成し、配線された版が SDK の申告値と一致することを確かめる。
  //      本番の実行時チェック (`assertApiVersionSupported`) もこの経路で走るので、
  //      値が空・想定外メジャーの場合は生成時の throw としてここで落ちる。
  //
  //      `getApiField` は SDK の型定義で `@private` とされ「将来削除しうる」と明記されている。
  //      それでも使うのは、**実際にクライアントへ配線された値**を読む手段が他に無いため
  //      (公開の定数どうしを比べるとトートロジーになる)。この結合は承知のうえで、SDK 更新で
  //      これが失われたら (b) と (c) が静的側の担保として残る、という前提で受け入れている
  it('配線された API バージョンが SDK の申告値と一致する', () => {
    expect(getStripeClient().getApiField('version')).toBe(Stripe.API_VERSION);
  });

  // (c) src 全体に日付入りリテラルが復活していないことを確かめる。
  //     1 ファイルに絞ると、写しを別モジュールへ置いて名前付き定数として import し直すだけで
  //     迂回できてしまう (実測で確認済み) ので、範囲は src 全体にする
  it('ソースに日付入りの API バージョンリテラルが直書きされていない', () => {
    expect(collectDatedVersionLiterals()).toEqual([]);
  });
});
