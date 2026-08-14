// リクエスト入口 (proxy) のボディ複製上限が、どの経路の上限も下回らないことを固定するテスト。
//
// なぜテストで縛るのか:
//   Next.js は proxy を持つアプリで、非 GET/HEAD のボディを入口で複製してバッファする。
//   `experimental.proxyClientMaxBodySize` が未設定だと既定 10MB になり、超えた本文は
//   **エラーにならず先頭 10MB で打ち切られたまま**ルートハンドラへ渡る。
//   本リポジトリにはメール取り込み (25MB)・添付付きチケット書き込み (51MB) という
//   10MB を超える経路があり、既定のままだと「大きめの添付だけが 400 になる」形で壊れる。
//   しかも壊れ方が静かなので、E2E (シードデータは小さい) でも表面化しない。
//   だからこそ、振る舞いではなく「入口の枠 ≧ 各経路の枠」という関係を直接固定する。
//
// 何を防ぐか:
//   (a) `next.config.ts` から設定が消える / 別の値に書き換わる退行。
//   (b) 導出をやめて数値を直書きし、入口の枠が経路の上限に追随しなくなった状態。
//   (c) 新しい経路の上限を足したのに `ROUTE_MAX_BODY_BYTES` へ登録し忘れた状態
//       (登録が人手の約束のままだと、静かな切り詰めがそのまま再発する)。
//   (d) `entry-body-limit.ts` の連鎖に `@/` エイリアスが混じり、`npm run build` だけが
//       落ちる状態 (typecheck とユニットテストは通ってしまう)。
//
// **ソースの走査は TypeScript のパーサで行う。** 以前は正規表現と自前の 1 文字走査で
// コメント除去・引数の切り出しをしていたが、文字列リテラル中の `//` や正規表現リテラル中の
// `/*` を取り違えて**検査対象が黙って消える**穴が繰り返し見つかった (見逃す方向の失敗なので
// 気付けない)。リポジトリは既に typescript に依存しているので、構文木から
// 「export された定数」「呼び出しの第 2 引数」を正確に取り出す。

// Vitest の DSL
import { beforeAll, describe, expect, it } from 'vitest';
// ソースを走査して「上限の定義漏れ」を拾うため (Node 標準の同期 API で十分)
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
// 構文木でソースを読むためのコンパイラ API (自前の字句解析をしないため)
import ts from 'typescript';
// 入口の枠と、その導出材料 (テスト側に書き写すと古びるので導出元から受け取る)
import {
  ENTRY_MAX_BODY_BYTES,
  ENTRY_OVER_LIMIT_MARGIN_BYTES,
  ENTRY_OVER_LIMIT_MARGIN_MIN_BYTES,
  NEXT_DEFAULT_ENTRY_MAX_BODY_BYTES,
  ROUTE_MAX_BODY_BYTES,
} from '@/lib/entry-body-limit';
// 実際に Next.js へ渡る設定オブジェクト (文字列一致ではなく値そのものを見る)
import nextConfig from '../next.config';

// リポジトリのルート (このテストファイルは <root>/tests/ にあるので 1 つ上)
const REPO_ROOT = join(__dirname, '..');
// 走査対象のソースディレクトリ
const SRC_DIR = join(REPO_ROOT, 'src');
// 導出元 (この一覧に登録されていない上限を落としたい)
const ENTRY_MODULE_PATH = join(SRC_DIR, 'lib', 'entry-body-limit.ts');
// 上限つき読み取り関数の定義元 (呼び出し側の検査では対象外にする)
const BOUNDED_READ_MODULE_PATH = join(SRC_DIR, 'lib', 'request-body-limit.ts');
// Next.js 自身の手順で読み込めるか試す設定ファイル
const NEXT_CONFIG_PATH = join(REPO_ROOT, 'next.config.ts');
// 導出元が持つ登録一覧の変数名 (構文木から中身を取り出すときの目印)
const REGISTRY_VARIABLE_NAME = 'ROUTE_MAX_BODY_BYTES';
// 経路上限の命名規約。この名前で export されたものを「経路の上限」とみなす。
// **命名に乗っていることが検出の前提**で、`MAX_UPLOAD_BYTES` のように外れた名前は拾えない
// (拾えないと入口の枠が追随せず、静かな切り詰めが戻る)。新しい経路上限はこの命名に揃えること
const ROUTE_LIMIT_NAME_PATTERN = /^[A-Z0-9_]*_MAX_BODY_BYTES$/;
// 上限つき読み取り関数の名前 (呼び出しと別名 import の両方で目印にする)
const BOUNDED_READ_FUNCTION_NAMES = [
  'readBodyWithinByteLimit',
  'readFormWithinByteLimit',
  'readTextWithinByteLimit',
];
// 上限つき読み取り関数を提供するモジュールの指定子 (別名 import を探すときの目印)
const BOUNDED_READ_MODULE_SPECIFIER = 'request-body-limit';
// パス区切り (POSIX/Windows いずれの表記でも同じ判定になるようにする)
const PATH_SEGMENT_SEPARATORS = ['/', '\\'];

/**
 * 生成物ディレクトリ (`src/generated/`) 配下かどうかを、**パス区切り単位**で判定する。
 *
 * 単純な前方一致にすると `generated-reports/limits.ts` のような別ディレクトリまで
 * 走査対象から外れ、そこに置かれた上限が検出網に入らなくなる。
 */
function isGeneratedPath(relativePath: string): boolean {
  // ディレクトリ名がちょうど `generated` で、その直後が区切り文字であることを求める
  return PATH_SEGMENT_SEPARATORS.some((sep) => relativePath.startsWith(`generated${sep}`));
}

// 走査したソースファイルのパスと構文木。**1 回だけ読んで全テストで使い回す**
// (テストごとに読み直すと同じ I/O と解析を 3 倍行ううえ、走査中にファイルが書き換わると
//  テストごとに見ている対象がずれる)
let parsedSources: { path: string; sourceFile: ts.SourceFile }[] = [];

/**
 * 1 ファイルを読み込んで構文木にする。
 *
 * 親ノードへの参照は使わないので `setParentNodes` は false にしてある (その分だけ軽い)。
 */
function parseFile(path: string): ts.SourceFile {
  // 拡張子に合わせた方言 (.tsx は JSX を含む) で解析する
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    false,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/**
 * `src/` 配下の .ts / .tsx を読み込み、構文木にして返す。
 *
 * `.tsx` も見るのは、上限がコンポーネント側 (フォームの事前検査など) に置かれても
 * 検出網から外れないようにするため。
 */
function parseSourceFiles(): { path: string; sourceFile: ts.SourceFile }[] {
  // src/ 配下を再帰的にたどり、対象拡張子だけを絶対パスにする (生成物は対象外)
  const files = readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
    .filter((rel) => (rel.endsWith('.ts') || rel.endsWith('.tsx')) && !isGeneratedPath(rel))
    .map((rel) => join(SRC_DIR, rel));
  // 1 ファイルずつ構文木にして返す
  return files.map((path) => ({ path, sourceFile: parseFile(path) }));
}

/**
 * 構文木を深さ優先でたどり、各ノードを訪問する。
 *
 * `ts.forEachChild` は子ノードだけを渡すので、入れ子の奥まで見るには自前で再帰する。
 */
function visitNodes(node: ts.Node, visit: (node: ts.Node) => void): void {
  // 今のノードを訪問する
  visit(node);
  // 子ノードへ降りる
  ts.forEachChild(node, (child) => visitNodes(child, visit));
}

/**
 * 1 ファイルから、経路上限として **export されている** 定数名をすべて拾う。
 *
 * 宣言形式 (`export const X = ...`) と、宣言と分けた公開 (`export { X }` /
 * `export { X } from '...'`) の両方を見る。後者を見ないと、バレル経由で足された上限が
 * 検出網を素通りする。
 */
function exportedRouteLimitNames(sourceFile: ts.SourceFile): string[] {
  // 見つけた定数名を溜める入れ物
  const names: string[] = [];
  // 構文木をたどって export を探す
  visitNodes(sourceFile, (node) => {
    // `export const X = ...` の形
    if (ts.isVariableStatement(node)) {
      // export 修飾子が付いていなければ対象外 (公開されていない定数はここでは見ない)
      const isExported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      // 付いていなければ何もしない
      if (!isExported) return;
      // 宣言された名前を順に見る
      for (const declaration of node.declarationList.declarations) {
        // 名前が識別子で、命名規約に合えば拾う
        const name = declaration.name;
        if (ts.isIdentifier(name) && ROUTE_LIMIT_NAME_PATTERN.test(name.text))
          names.push(name.text);
      }
      return;
    }
    // `export { X }` / `export { X as Y } from '...'` の形
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      // 公開される名前 (別名があれば別名) を順に見る
      for (const element of node.exportClause.elements) {
        // 命名規約に合えば拾う
        if (ROUTE_LIMIT_NAME_PATTERN.test(element.name.text)) names.push(element.name.text);
      }
    }
  });
  // 見つかった名前を返す
  return names;
}

/**
 * 導出元の `ROUTE_MAX_BODY_BYTES` に**実際に登録されている**定数名を返す。
 *
 * 値ではなく名前で突き合わせるのは、各モジュールを動的 import すると将来重い依存
 * (Prisma 等) を持つモジュールが混ざったときにテストごと巻き添えになるため。
 */
function registeredRouteLimitNames(): string[] {
  // 導出元だけを構文木にする
  const sourceFile = parseFile(ENTRY_MODULE_PATH);
  // 登録されている名前を溜める入れ物
  const names: string[] = [];
  // 目印の変数宣言を探し、その配列リテラルの要素名を拾う
  visitNodes(sourceFile, (node) => {
    // 変数宣言でなければ関係ない
    if (!ts.isVariableDeclaration(node)) return;
    // 名前が目印と一致しなければ関係ない
    if (!ts.isIdentifier(node.name) || node.name.text !== REGISTRY_VARIABLE_NAME) return;
    // 初期化式が無ければ何も拾えない
    const initializer = node.initializer;
    if (!initializer) return;
    // `as const` が付いていれば中の式を取り出す
    const array = ts.isAsExpression(initializer) ? initializer.expression : initializer;
    // 配列リテラルでなければ形が変わったということなので、登録ゼロとして扱う (落ちる方に倒す)
    if (!ts.isArrayLiteralExpression(array)) return;
    // 要素として並んでいる識別子を拾う
    for (const element of array.elements) {
      if (ts.isIdentifier(element)) names.push(element.text);
    }
  });
  // 見つかった名前を返す
  return names;
}

/**
 * `src/` 配下で経路上限として export されているのに、`ROUTE_MAX_BODY_BYTES` へ
 * 登録されていない定数名を返す (空なら登録漏れ無し)。
 */
function unregisteredRouteLimitNames(): string[] {
  // 一覧に登録済みの定数名 (完全一致で突き合わせる)
  const registered = registeredRouteLimitNames();
  // 導出元自身が export する枠 (ENTRY_MAX_BODY_BYTES 等) は経路の上限ではないので除外する
  const entry = parsedSources.find((source) => source.path === ENTRY_MODULE_PATH);
  const ownExports = entry ? exportedRouteLimitNames(entry.sourceFile) : [];
  // 登録漏れの定数名を溜める入れ物 (同じ名前を 2 度報告しないよう集合で持つ)
  const missing = new Set<string>();
  // 1 ファイルずつ、公開されている経路上限を見る
  for (const { sourceFile } of parsedSources) {
    for (const name of exportedRouteLimitNames(sourceFile)) {
      // 導出元自身の export は経路の上限ではないので飛ばす
      if (ownExports.includes(name)) continue;
      // 一覧に完全一致で載っていなければ登録漏れ
      if (!registered.includes(name)) missing.add(name);
    }
  }
  // 失敗時のメッセージを安定させるため並べ替えて返す
  return [...missing].sort();
}

/**
 * 上限つき読み取り関数を**別名で import / re-export している**箇所を返す (空なら違反なし)。
 *
 * 呼び出し検査は関数名そのものを手掛かりにしているため、`readBounded(req, ...)` のように
 * 別名を付けられると呼び出しごと検出網から消える。名前を変えられないようにして手掛かりを守る。
 */
function boundedReadAliasImports(): string[] {
  // 違反 (ファイルと別名) を溜める入れ物
  const offenders: string[] = [];
  // 1 ファイルずつ import / export 宣言を見る
  for (const { path, sourceFile } of parsedSources) {
    visitNodes(sourceFile, (node) => {
      // import / export のどちらでもなければ関係ない
      const isImport = ts.isImportDeclaration(node);
      const isExport = ts.isExportDeclaration(node);
      if (!isImport && !isExport) return;
      // 読み取り関数のモジュールを指していなければ関係ない
      const specifier = node.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier)) return;
      if (!specifier.text.includes(BOUNDED_READ_MODULE_SPECIFIER)) return;
      // 名前付きの取り込み / 再公開の要素を取り出す
      const clause = isImport ? node.importClause?.namedBindings : node.exportClause;
      if (!clause) return;
      if (!ts.isNamedImports(clause) && !ts.isNamedExports(clause)) return;
      // 「元の名前 as 別名」になっている要素だけを違反として拾う
      for (const element of clause.elements) {
        // 元の名前 (別名を付けていなければ undefined)
        const original = element.propertyName?.text;
        // 別名が無い、または元の名前が対象関数でなければ問題なし
        if (!original || !BOUNDED_READ_FUNCTION_NAMES.includes(original)) continue;
        // 別名を付けているので違反として記録する
        offenders.push(`${path}: ${original} as ${element.name.text}`);
      }
    });
  }
  // 失敗時のメッセージを安定させるため並べ替えて返す
  return offenders.sort();
}

/**
 * `readBodyWithinByteLimit` 系へ、**導出元に登録済みの定数以外**を上限として渡している
 * 呼び出しを返す (空なら全呼び出しが登録済みの定数を使っている)。
 *
 * 登録漏れ検出は export された定数しか見られないため、
 * (a) `readFormWithinByteLimit(req, 100 * 1024 * 1024)` のような数値リテラル直渡し、
 * (b) ルート内に置いた **export しないローカル定数** (命名規約は満たすので名前検査も素通りする)
 * のどちらも、あちらでは捕まらない。**「呼び出しで使ってよいのは登録済みの名前だけ」**という
 * 形にすれば両方まとめて塞げる。
 */
function boundedReadCallsWithUnregisteredLimit(): string[] {
  // 一覧に登録済みの定数名
  const registered = registeredRouteLimitNames();
  // 違反 (ファイルと渡された式) を溜める入れ物
  const offenders = new Set<string>();
  // 1 ファイルずつ呼び出しを見る
  for (const { path, sourceFile } of parsedSources) {
    // 読み取り関数そのものを定義しているモジュールは対象外。ここでの `maxBytes` は
    // 呼び出し元から受け取った引数を転送しているだけで、経路の上限ではない
    if (path === BOUNDED_READ_MODULE_PATH) continue;
    visitNodes(sourceFile, (node) => {
      // 呼び出し式でなければ関係ない
      if (!ts.isCallExpression(node)) return;
      // 呼び出している名前が対象関数でなければ関係ない
      const callee = node.expression;
      if (!ts.isIdentifier(callee) || !BOUNDED_READ_FUNCTION_NAMES.includes(callee.text)) return;
      // 第 2 引数 (maxBytes) を取り出す。無ければ型エラーになる形だが、念のため違反扱いにする
      const maxBytesArgument = node.arguments[1];
      if (!maxBytesArgument) {
        offenders.add(`${path}: ${callee.text}(...) に上限が渡されていません`);
        return;
      }
      // 識別子で、かつ登録済みの名前ならよい
      if (ts.isIdentifier(maxBytesArgument) && registered.includes(maxBytesArgument.text)) return;
      // それ以外は、書かれている式をそのまま添えて報告する
      offenders.add(`${path}: ${maxBytesArgument.getText(sourceFile)}`);
    });
  }
  // 失敗時のメッセージを安定させるため並べ替えて返す
  return [...offenders].sort();
}

describe('入口 (proxy) のボディ複製上限', () => {
  // ソースの読み込みと構文解析は 1 回だけ行い、全テストで同じ対象を見る
  beforeAll(() => {
    parsedSources = parseSourceFiles();
  });

  it('入口の枠が「経路別上限の最大値 + 余白」ちょうどで導出されている', () => {
    // 経路別上限の最大値 (導出元が公開している一覧から計算する)
    const largestRouteLimit = Math.max(...ROUTE_MAX_BODY_BYTES);
    // **不等号ではなく厳密等価で見るのが要点。** `>=` だと、導出をやめて数値を直書きした
    // うえで新しい経路上限 (例: 200MB) を足したときに、入口の枠が追随していないのに
    // 通ってしまう (実際にその形で退行を作れることを確認した)。厳密等価なら落ちる。
    // なお「今の値と同じ数値を直書きしただけ」は等価なので通るが、それは現時点で害が無く、
    // どこかの経路上限が動いた瞬間にここで落ちる。
    // 一覧をテスト側に書き写さないのも同じ理由 — 写すと経路を足したときにそちらが古くなり、
    // 「新しい経路が検査から丸ごと抜けているのに緑」になる
    expect(ENTRY_MAX_BODY_BYTES).toBe(largestRouteLimit + ENTRY_OVER_LIMIT_MARGIN_BYTES);
  });

  it('余白が、超過を観測できる最小サイズを下回っていない', () => {
    // 余白が小さすぎると、入口が捨てるチャンクの分だけルートが超過を観測できなくなり、
    // chunked 転送の超過が 413 ではなく 400 に化ける。**固定するのは下限だけ**で、
    // 実際の値 (1MB) は「将来 highWaterMark が変わっても効く余裕」として厚めに取ってある
    // — リテラルまで固定すると、余裕を見直すだけで落ちる単なる変更検知になる
    expect(ENTRY_OVER_LIMIT_MARGIN_BYTES).toBeGreaterThanOrEqual(ENTRY_OVER_LIMIT_MARGIN_MIN_BYTES);
  });

  it('Next.js の既定 (10MB) では足りないことを明示する', () => {
    // 既定のままだと 10MB を超える経路が壊れる、という前提そのものを固定しておく。
    // ここが等しくなったら「設定は不要になった」ではなく「上限の構成が変わった」合図で、
    // 上のケースと合わせて設定の要否を見直すことになる
    expect(ENTRY_MAX_BODY_BYTES).toBeGreaterThan(NEXT_DEFAULT_ENTRY_MAX_BODY_BYTES);
  });

  it('next.config.ts が入口の枠をそのまま Next.js へ渡している', () => {
    // 設定漏れ・書き換えを検出する。文字列一致ではなく、実際に export される値を見る
    expect(nextConfig.experimental?.proxyClientMaxBodySize).toBe(ENTRY_MAX_BODY_BYTES);
  });

  it('Next.js 自身の手順で next.config.ts を読み込める', async () => {
    // **ここは近似ではなく実物を通す。** `import nextConfig from '../next.config'` は
    // vitest のエイリアス解決を通るので、Next.js が config を読むときの制約
    // (自身の import しか `paths` を書き換えない = 連鎖の先の `@/...` は解決できない) を
    // 再現しない。実際 `entry-body-limit.ts` の連鎖に `@/` を 1 本混ぜると
    // typecheck もユニットテストも通ったまま `npm run build` だけが落ちる。
    // Next.js の transpile 手順をそのまま呼んで、その退行を速い検査で捕まえる
    const { transpileConfig } = await import('next/dist/build/next-config-ts/transpile-config');
    // next.config.ts を Next.js と同じ方法で読み込む (失敗すれば例外でこのテストが落ちる)。
    // 戻り値はモジュール名前空間の形なので、default export を取り出して中身を見る
    const loaded = await transpileConfig({ nextConfigPath: NEXT_CONFIG_PATH, dir: REPO_ROOT });
    // 読み込めた設定が、導出した枠をそのまま渡していることまで確認する
    expect(loaded.default?.experimental?.proxyClientMaxBodySize).toBe(ENTRY_MAX_BODY_BYTES);
  });

  it('src/ 配下の経路上限がすべて ROUTE_MAX_BODY_BYTES に登録されている', () => {
    // 導出元の一覧に載っていない上限があると、その経路だけ入口で切り詰められる。
    // 「足したら登録する」を人手の約束にせず、ここで機械的に落とす
    expect(unregisteredRouteLimitNames()).toEqual([]);
  });

  it('上限つき読み取り関数が別名で import されていない', () => {
    // 別名を付けられると呼び出し検査 (関数名が手掛かり) が丸ごと素通りする
    expect(boundedReadAliasImports()).toEqual([]);
  });

  it('上限つき読み取りの呼び出しが登録済みの定数だけを上限に使っている', () => {
    // 数値リテラルの直渡しや、export しないローカル定数を上限にすると、上の登録漏れ検出
    // (export された名前が手掛かり) に引っかからず、その経路だけ入口の枠が追随しないまま
    // 静かに切り詰められる。「使ってよいのは登録済みの名前だけ」の形にして両方を塞ぐ
    expect(boundedReadCallsWithUnregisteredLimit()).toEqual([]);
  });
});
