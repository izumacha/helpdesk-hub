// 実行イメージへ入れる seed 用ソースの集合が、実際に必要な集合と一致することを固定するテスト。
//
// なぜテストで縛るのか:
//   `docker compose exec app npx prisma db seed` (README / CLAUDE.md §2 の手順) は、
//   実行イメージへ手で選んで入れた `src/` 配下のファイルだけで動く。Dockerfile は
//   `src/lib` を丸ごとではなく seed が要るファイルだけコピーしている (認証・SSO・メールの
//   ソースを実行イメージへ持ち込まないため) が、その「要るファイル」は人手の約束にすぎない。
//   `prisma/seed.ts` が `src/lib` のモジュールをもう 1 つ import した日に、イメージからは
//   静かに欠け、**本番のコンテナで seed を叩いたときだけ** `Cannot find module` で落ちる。
//   CI はイメージをビルドしないので、この壊れ方はマージ後まで表面化しない。
//
// 何を防ぐか:
//   (a) seed の import が増えたのに Dockerfile の COPY を足し忘れた状態 (イメージが壊れる)。
//   (b) 逆に、もう要らない / 一度も要らなかったファイルを実行イメージへ入れたままの状態
//       (最小公開の後退。`src/lib` を丸ごと戻す変更もここで落ちる)。
//
// **ソースの走査は TypeScript のパーサで行う** (`tests/entry-body-limit.test.ts` と同じ理由:
// 正規表現だと文字列リテラル中の import らしき文字列を拾う / 実際の import を取り落とす、
// どちらの間違いも「検査が黙って緩む」方向に効いてしまうため)。

// Vitest の DSL
import { describe, expect, it } from 'vitest';
// ソースと Dockerfile を読むため (Node 標準の同期 API で十分)
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
// 構文木でソースを読むためのコンパイラ API (自前の字句解析をしないため)
import ts from 'typescript';

// リポジトリのルート (このテストファイルは tests/ 直下にある)
const REPO_ROOT = resolve(__dirname, '..');
// 走査の起点。`prisma db seed` が実行するスクリプト (コマンド定義は prisma.config.ts)
const SEED_ENTRY = join(REPO_ROOT, 'prisma/seed.ts');
// 実行イメージへ手で選んで入れる対象のディレクトリ (この配下だけを「過不足」の検査対象にする)
const HAND_PICKED_DIR = 'src/lib';
// TypeScript ソースとして解決を試みる拡張子 (import の指定に拡張子が無いため補う)
const SOURCE_EXTENSIONS = ['.ts', '.tsx'];

// import / export / dynamic import の指定子をソース 1 ファイルから集める
function collectModuleSpecifiers(filePath: string): string[] {
  // ファイルの中身を読む
  const sourceText = readFileSync(filePath, 'utf8');
  // 構文木を作る (最新の構文で解析し、親ノードは辿らないので setParentNodes は false)
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, false);
  // 見つけた指定子を貯める配列
  const specifiers: string[] = [];
  // 構文木を再帰的に歩く関数
  function visit(node: ts.Node): void {
    // `import ... from '...'` と `export ... from '...'` の指定子を拾う
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    // `import('...')` (動的 import) の指定子も拾う
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    // 子ノードへ降りる
    ts.forEachChild(node, visit);
  }
  // ルートから走査を始める
  visit(sourceFile);
  // 集めた指定子を返す
  return specifiers;
}

// 指定子を実ファイルのパスへ解決する (解決できない = 外部パッケージなら undefined)
function resolveSpecifier(specifier: string, importerPath: string): string | undefined {
  // `@/xxx` はパスエイリアス (tsconfig の paths) で src/xxx を指す
  const base = specifier.startsWith('@/')
    ? join(REPO_ROOT, 'src', specifier.slice('@/'.length))
    : // `./xxx` / `../xxx` は import 元からの相対パス
      specifier.startsWith('.')
      ? resolve(dirname(importerPath), specifier)
      : // それ以外は node_modules のパッケージなので追わない
        undefined;
  // パッケージ import はここで終了
  if (!base) return undefined;
  // 拡張子つき / index つきの候補を順に試し、最初に見つかった実ファイルを返す
  for (const candidate of [
    base,
    ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => join(base, `index${extension}`)),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  // ディレクトリだけ存在する等、ファイルとして解決できなければ未解決として扱う
  return undefined;
}

// seed から辿れる `src/` 配下のファイル一覧 (リポジトリルートからの相対パス) を集める
function collectSeedSourceFiles(): Set<string> {
  // 走査済みの絶対パス (同じファイルを 2 度開かないため)
  const visited = new Set<string>();
  // 結果として返す `src/` 配下のファイル集合
  const sourceFiles = new Set<string>();
  // 幅優先で辿るための待ち行列 (起点は seed 本体)
  const queue = [SEED_ENTRY];
  // 待ち行列が空になるまで辿る
  while (queue.length > 0) {
    // 次に調べるファイルを取り出す
    const current = queue.shift() as string;
    // 既に見たファイルなら飛ばす
    if (visited.has(current)) continue;
    // 見たことにする
    visited.add(current);
    // このファイルが `src/` 配下なら結果に加える (起点の prisma/seed.ts は対象外)
    const relativePath = relative(REPO_ROOT, current);
    if (relativePath.startsWith('src/')) sourceFiles.add(relativePath);
    // このファイルの import 先をすべて解決して待ち行列へ積む
    for (const specifier of collectModuleSpecifiers(current)) {
      const resolved = resolveSpecifier(specifier, current);
      if (resolved) queue.push(resolved);
    }
  }
  // 集めた集合を返す
  return sourceFiles;
}

// Dockerfile が実行イメージ (runner ステージ) へ入れる `src/` 配下のパスを集める
function collectRunnerCopiedSourcePaths(): string[] {
  // Dockerfile を 1 行ずつに分ける
  const lines = readFileSync(join(REPO_ROOT, 'Dockerfile'), 'utf8').split('\n');
  // runner ステージに入ってからの COPY だけを見るためのフラグ
  let inRunnerStage = false;
  // 見つかったコピー元パスを貯める配列
  const copiedPaths: string[] = [];
  // 上から順に読む
  for (const line of lines) {
    // `FROM ... AS <stage>` でステージが切り替わる
    const stageMatch = line.match(/^\s*FROM\s+.*\sAS\s+(\S+)/i);
    if (stageMatch) inRunnerStage = stageMatch[1] === 'runner';
    // runner ステージ以外の COPY は実行イメージに残らないので見ない
    if (!inRunnerStage) continue;
    // `COPY --from=builder /app/src/... <dest>` のコピー元を拾う
    const copyMatch = line.match(/^\s*COPY\s+.*--from=builder\s+(?:--\S+\s+)*\/app\/(src\/\S*)/);
    if (copyMatch) copiedPaths.push(copyMatch[1].replace(/\/$/, ''));
  }
  // 集めたパスを返す
  return copiedPaths;
}

describe('Dockerfile の runner ステージが seed 用ソースを過不足なく含む', () => {
  // seed から辿れる `src/` 配下のファイル (真実の源はソースの import グラフ)
  const requiredFiles = collectSeedSourceFiles();
  // Dockerfile が実行イメージへ入れる `src/` 配下のパス
  const copiedPaths = collectRunnerCopiedSourcePaths();

  it('走査の前提が崩れていない (seed から src 配下のファイルを 1 つ以上辿れる)', () => {
    // 解決に失敗して集合が空になると、以降の検査が素通りしてしまうので先に確かめる
    expect(requiredFiles.size).toBeGreaterThan(0);
    // Dockerfile 側も同様に、1 つも拾えていない状態を弾く
    expect(copiedPaths.length).toBeGreaterThan(0);
  });

  it('seed が import する src 配下のファイルはすべて実行イメージへコピーされる', () => {
    // コピー対象に含まれないファイル = コンテナ内の seed が Cannot find module で落ちるファイル
    const missing = [...requiredFiles].filter(
      (file) => !copiedPaths.some((path) => file === path || file.startsWith(`${path}/`)),
    );
    // 1 つも無いことを求める (足りない場合はそのパスがそのまま出る)
    expect(missing).toEqual([]);
  });

  it(`実行イメージへ手で入れる ${HAND_PICKED_DIR} 配下は seed が実際に使うものだけ`, () => {
    // 手で選んでいる範囲 (src/lib 配下) のコピー指定だけを取り出す
    const handPicked = copiedPaths.filter((path) => path.startsWith(HAND_PICKED_DIR));
    // seed から辿れないのに入れているもの = 実行イメージへ余計に晒しているソース
    const unnecessary = handPicked.filter(
      (path) => ![...requiredFiles].some((file) => file === path || file.startsWith(`${path}/`)),
    );
    // 1 つも無いことを求める (`src/lib` を丸ごとコピーする変更もここで落ちる)
    expect(unnecessary).toEqual([]);
  });
});
