// 検出網テストが共有する、TypeScript ソースの読み取りヘルパー。
//
// なぜ共有するのか:
//   `tests/entry-body-limit.test.ts` と `tests/docker-seed-files.test.ts` は、どちらも
//   「ソースを構文木にする」「import の指定子を `src/` 配下の実ファイルへ解決する」という
//   同じ土台の上に別の検査を載せている。写しを 2 つ持つと、片方だけ直したときに
//   もう片方の検出網が静かに緩む (どちらも「見逃す方向」に壊れるので気付けない)。
//   CLAUDE.md §6 の DRY に従い、土台だけをここへ集約する。
//
// **正規表現ではなく TypeScript のパーサを使う。** 文字列リテラル中の import らしき文字列を
// 拾ってしまう / 実際の import を取り落とす、どちらの間違いも検査を緩める方向に効くため。

// ファイルの読み込みと存在確認 (Node 標準の同期 API で十分)
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
// 構文木でソースを読むためのコンパイラ API
import ts from 'typescript';

/**
 * 1 ファイルを読み込んで構文木にする。
 *
 * 親ノードへの参照は使わないので `setParentNodes` は false にしてある (その分だけ軽い)。
 */
// ソースファイル 1 つを構文木にする
export function parseSourceFile(path: string): ts.SourceFile {
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
 * 構文木を深さ優先でたどり、各ノードを訪問する。
 *
 * `ts.forEachChild` は子ノードだけを渡すので、入れ子の奥まで見るには自前で再帰する。
 */
// 構文木の全ノードを訪問する
export function visitNodes(node: ts.Node, visit: (node: ts.Node) => void): void {
  // 今のノードを訪問する
  visit(node);
  // 子ノードへ降りる
  ts.forEachChild(node, (child) => visitNodes(child, visit));
}

/**
 * import / export 宣言の指定子を、`src/` 配下の絶対パスへ解決する (解決できなければ null)。
 *
 * 対応するのは本リポジトリで実際に使う 2 形だけ: `@/...` エイリアス (tsconfig の `@/*` → `src/*`)
 * と相対パス。`next/...` のような外部パッケージは解決対象外なので null を返す。
 * 拡張子なしで書かれるのが通例なので、`.ts` / `.tsx` / ディレクトリの `index` を順に試す。
 */
// 指定子を実ファイルの絶対パスへ解決する
export function resolveModuleSpecifier(
  specifier: string,
  fromPath: string,
  srcDir: string,
): string | null {
  // エイリアスなら src/ 起点、相対パスなら import 元のディレクトリ起点で組み立てる
  const base = specifier.startsWith('@/')
    ? join(srcDir, specifier.slice('@/'.length))
    : specifier.startsWith('.')
      ? join(dirname(fromPath), specifier)
      : null;
  // どちらでもなければ外部パッケージなので解決しない
  if (base === null) return null;
  // 拡張子の付け方を順に試し、**実在するファイル**だった最初のものを採用する。
  // **ディレクトリを弾くのが要点**: `@/data` のようなディレクトリ import では `base` 自体が
  // 実在してしまい、そこで確定すると `src/data/index.ts` へ辿り着けない。すると
  // 「index.ts はバレルとして集合に入っているのに、`@/data` と書いた側は集合外」という
  // ねじれが起き、両方の import 禁止をすり抜ける (`@/data` 形式はこのリポジトリで実際に多用されている)
  // `.js` / `index.js` を **後ろに** 置くのが要点: 生成物 (`@/generated/prisma` は .js と .d.ts
  // しか持たない) も解決できるようにしつつ、.ts が併存する場合は従来どおり .ts を優先する
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
    `${base}.js`,
    join(base, 'index.js'),
  ])
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  // どれも実在しなければ解決できない
  return null;
}

/**
 * 1 ファイルに書かれた import / export / 動的 import の指定子をすべて集める。
 *
 * 静的な `import ... from` だけでなく `export ... from` と `import('...')` も見るのは、
 * どちらも実行時に読み込まれる依存であり、見落とすと依存グラフに穴が空くため。
 */
// ソース 1 ファイルからモジュール指定子を集める
export function collectModuleSpecifiers(sourceFile: ts.SourceFile): string[] {
  // 見つけた指定子を貯める配列
  const specifiers: string[] = [];
  // 構文木をたどって指定子を拾う
  visitNodes(sourceFile, (node) => {
    // `import ... from '...'` と `export ... from '...'` の指定子
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    // `import('...')` (動的 import) の指定子
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
  });
  // 集めた指定子を返す
  return specifiers;
}
