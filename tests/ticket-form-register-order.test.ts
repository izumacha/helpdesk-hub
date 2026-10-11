// チケット登録フォームの「register を呼ぶ順」が「画面に出てくる順」と一致していることを見る検出網。
//
// なぜ要るのか:
//   react-hook-form は `register()` が呼ばれた順を `control._names.mount` に控えており、
//   検証に失敗した送信では **その順で最初のエラー欄** へカーソルを移す (`shouldFocusError`)。
//   つまり呼ぶ順を入れ替えると、画面の上に出ているエラーを飛び越してカーソルが下の欄へ飛ぶ。
//   実際 PR #347 で、内容欄の onBlur を要素側で合成するために `register('body')` だけを
//   JSX の手前へ持ち上げたところ、登録順が [body, title, …] になり、タイトルと内容が
//   どちらも空のまま送信するとカーソルが**内容欄**へ飛ぶようになっていた
//   (タイトル欄のエラー文はその上に出ているのに素通りする)。
//   lint・型チェック・1632 件のユニットテスト・build はすべて緑のままだった
//   (ユニットテストは `environment: 'node'` ＋ `tests/**/*.test.ts` なので画面を描画しない)。
//
// 何を見ているか:
//   (a) `register('<名前>')` の **呼び出し順** (ソース上の出現順。持ち上げた行は JSX より前にある)
//   (b) その登録結果を `{...}` で渡している **要素の出現順**
//   (c) **持ち上げた欄** (JSX の `{...}` の外で呼ばれた `register`) が (b) に現れること
//   (d) `register('<名前>')` を呼ぶファイルが、この検査対象だけであること
//   (a) と (b) は（両方に現れる欄について）同じ並びであることを要求する。
//
// 守備範囲の境界（正直に書く）:
//   要素側の `{...x}` から欄の名前へ辿れない書き方（分割代入で受け直す等）をすると、
//   その欄は (b) の一覧に載らないので順番の照合から外れる。欄を増やす正当な変更を
//   「直しようの無い赤」にしないためにこうしてあり、代わりに (b) が空になる／
//   1 件しか取れない状態は前提崩れとして落とす（検査が無言で空回りするのを防ぐ）。
//
//   **ただし「持ち上げた欄」はこの例外に入れない (c)。** 照合は「両方に現れる欄」に絞って
//   いるので、持ち上げた欄が (b) から落ちると **(a) 側からも一緒に落ちて、まさにこの
//   検出網が防ぐはずの並び替えが素通りする**（実測: `{...titleField}` を
//   `{...{ ...titleField }}` にする・`const { ref, ...rest }` で受け直す・
//   `const { onBlur, ...rest } = register('body')` と分割代入で受ける、のいずれかを入れた
//   うえで内容欄の register を手前へ戻すと、PR #347 の退行そのものが再現するのに全件緑で
//   通った）。持ち上げた欄は **register の呼び出しが要素から切り離されている欄**＝この
//   検出網の対象そのものなので、(b) に現れることを fail-closed で要求する。
//   判定は**宣言の書き方ではなく「JSX の `{...}` の中にあるか」**で行う —— 宣言の形
//   （識別子への代入）で判定すると、上記の分割代入で受ける形が (c) からも抜け落ちる。
//   インラインの `{...register('x')}` は要素と一緒に動くので順番がずれようが無く、
//   この要求の対象にしない（辿れない書き方をしても境界どおり照合から外れるだけ）。
//
//   **(c) は「要素を持たない欄は比べない」という上の許容を、持ち上げた欄に限って上書きする。**
//   スプレッドを受け付けない入力へ `name=` / `ref=` を個別に渡したい場合は、(c) が落ちるので
//   **その欄だけインラインの `{...register('x')}` へ戻す**か、持ち上げたまま
//   `{...xField}` も併せて渡す（どちらも採れないときは、この境界の節に理由を書いて検査を直す）。
//
//   (d) は「欄が子コンポーネントへ移る／2 つ目のフォームが増える」ときに、この検査が
//   対象を失ったまま緑になるのを防ぐ（移った先は (a)(b) の一覧から消えるだけで、
//   空回りの検査も `> 1` を満たし続ける＝実測）。落ちたら検査対象を広げる。

// テストの宣言
import { describe, expect, it } from 'vitest';
// ソースを構文木で読む共有ヘルパー（§6 DRY。正規表現で読まない理由はヘルパー側に書いてある）
import { parseSourceFile, parseSourceFiles, visitNodes, SRC_DIR } from './lib/source-module-graph';
// 構文木のノード種別を見分けるためのコンパイラ API
import ts from 'typescript';
// 検査対象のパスを組み立てる
import { join } from 'node:path';

// 検査対象のファイル（走査範囲の正本である SRC_DIR から組み立てる。§6 DRY）
const FORM_PATH = join(SRC_DIR, 'features/tickets/components/TicketForm.tsx');

/** `register('<名前>')` という呼び出しなら欄の名前を返す（そうでなければ null）。 */
function registeredFieldName(node: ts.Node): string | null {
  // 呼び出し式でなければ対象外
  if (!ts.isCallExpression(node)) return null;
  // 呼び出している先が識別子 `register` でなければ対象外（`repos.x.register(...)` は別物）
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'register') return null;
  // 第 1 引数を取り出す（無ければ対象外）
  const first = node.arguments[0];
  // 文字列リテラルでなければ名前を決められないので対象外
  if (!first || !ts.isStringLiteralLike(first)) return null;
  // 欄の名前を返す
  return first.text;
}

/** 配列から重複を取り除く（最初に現れた順を保つ）。 */
function firstOccurrences(names: readonly string[]): string[] {
  // Set は挿入順を保つので、そのまま配列へ戻せば「初出の順」になる
  return [...new Set(names)];
}

describe('チケット登録フォームの欄の登録順', () => {
  // ソースを 1 度だけ構文木にする（以降の検査で使い回す）
  const source = parseSourceFile(FORM_PATH);

  // ソース上の位置つきで「register の呼び出し」と「要素への受け渡し」を集める
  const registerCalls: { pos: number; name: string }[] = [];
  const localToField = new Map<string, string>();
  const spreads: { pos: number; end: number; local: string | null; inline: string | null }[] = [];

  // 構文木を 1 度たどって 3 つを同時に集める
  visitNodes(source, (node) => {
    // `register('x')` の呼び出しを記録する
    const called = registeredFieldName(node);
    if (called !== null) registerCalls.push({ pos: node.getStart(source), name: called });
    // `const xField = register('x')` の形なら、ローカル名 → 欄の名前を覚える
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      const init = registeredFieldName(node.initializer);
      if (init !== null) localToField.set(node.name.text, init);
    }
    // JSX の `{...何か}` を記録する（インラインの register か、ローカル名か。範囲も残す）
    if (ts.isJsxSpreadAttribute(node)) {
      const inline = registeredFieldName(node.expression);
      spreads.push({
        pos: node.getStart(source),
        end: node.getEnd(),
        local: ts.isIdentifier(node.expression) ? node.expression.text : null,
        inline,
      });
    }
  });

  // 呼び出し順（ソース上の位置で並べ、初出だけ残す）
  const callOrder = firstOccurrences(
    [...registerCalls].sort((a, b) => a.pos - b.pos).map((entry) => entry.name),
  );
  // 要素の出現順（名前へ辿れたものだけ。辿れない書き方は境界としてここから落ちる）
  const elementOrder = firstOccurrences(
    [...spreads]
      .sort((a, b) => a.pos - b.pos)
      .map((entry) => entry.inline ?? (entry.local ? localToField.get(entry.local) : undefined))
      .filter((name): name is string => typeof name === 'string'),
  );
  // 持ち上げた欄の集合（JSX の `{...}` の範囲の外で呼ばれた register。順序は使わない）
  const hoistedFields = new Set(
    registerCalls
      .filter((call) => !spreads.some((sp) => call.pos >= sp.pos && call.pos < sp.end))
      .map((call) => call.name),
  );

  it('検査が空回りしていない（前提の確認）', () => {
    // register の呼び出しが 1 つも取れないなら読み方が壊れている（fail-closed）
    expect(callOrder.length).toBeGreaterThan(1);
    // 要素側も 2 件以上取れていなければ順番を比べる意味がない（fail-closed）
    expect(elementOrder.length).toBeGreaterThan(1);
    // 持ち上げた欄が 1 つも無いなら (c) は何も見ていない（fail-closed）
    expect(hoistedFields.size).toBeGreaterThan(0);
  });

  it('持ち上げた欄は必ず要素側にも現れる（照合から落ちない）', () => {
    // 持ち上げた欄のうち、要素側の一覧に現れなかったものを拾う（落ちると照合から静かに外れる）
    const missing = [...hoistedFields].filter((name) => !elementOrder.includes(name));
    // 1 つも無いことを要求する（落ちたときの直し方は冒頭の境界の節に書いてある）
    expect(missing).toEqual([]);
  });

  it('register を呼ぶ順が、画面に出てくる順と一致する', () => {
    // 要素側に出てくる欄だけに絞った呼び出し順（登録だけして要素を持たない欄は比べない）
    const comparable = callOrder.filter((name) => elementOrder.includes(name));
    // 2 つの並びが一致することを要求する（ずれていたらカーソルの飛び先が画面と食い違う）
    expect(comparable).toEqual(elementOrder);
  });

  it('register を呼ぶのはこの検査対象のファイルだけ（対象の取りこぼしを防ぐ）', () => {
    // src 配下を走査し、`register('<名前>')` の呼び出しを 1 つでも持つファイルを集める
    const callers = parseSourceFiles()
      .filter(({ sourceFile }) => {
        // そのファイルに該当する呼び出しがあるかを構文木で調べる
        let found = false;
        visitNodes(sourceFile, (node) => {
          if (registeredFieldName(node) !== null) found = true;
        });
        return found;
      })
      .map(({ path }) => path);
    // 検査対象のファイルだけであることを要求する（増えたら検査対象を広げる）
    expect(callers).toEqual([FORM_PATH]);
  });
});
