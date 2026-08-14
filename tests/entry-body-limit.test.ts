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
// 前段プロキシの設定例が下回っていないか検算するための、経路側の実際の上限値
import {
  INBOUND_EMAIL_MAX_BODY_BYTES,
  LINE_WEBHOOK_MAX_BODY_BYTES,
  STRIPE_WEBHOOK_MAX_BODY_BYTES,
} from '@/lib/webhook-body-limits';
import {
  ATTACHMENT_UPLOAD_MAX_BODY_BYTES,
  TICKET_JSON_MAX_BODY_BYTES,
} from '@/lib/ticket-body-limits';
import { MAGIC_LINK_CALLBACK_MAX_BODY_BYTES, SSO_ACS_MAX_BODY_BYTES } from '@/lib/auth-body-limits';
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
// 上限つき読み取り関数の命名規約。`request-body-limit.ts` が export する関数のうち
// この名前で終わるものを「上限つき読み取り関数」とみなす。
// **手書きの一覧にしないのが要点。** 以前は 3 つを直接並べていたが、それだと読み取り関数を
// 1 本足したときに呼び出し検査 (関数名が手掛かり) も別名検査もその関数を見なくなり、
// `readXxxWithinByteLimit(req, 500 * 1024 * 1024)` のような直渡しが検出網を素通りする
// (実測で再現)。`ROUTE_MAX_BODY_BYTES` の登録漏れを機械的に落としているのと同じ理由で、
// ここも人手の約束をやめて定義元から導出する
const BOUNDED_READ_FUNCTION_NAME_PATTERN = /WithinByteLimit$/;
// 上限つき読み取り関数を提供するモジュールの指定子 (別名 import を探すときの目印)
const BOUNDED_READ_MODULE_SPECIFIER = 'request-body-limit';
// 前段リバースプロキシの設定例を載せているドキュメント (値の陳腐化を機械的に落とす対象)
const SECURITY_DOC_PATH = join(REPO_ROOT, 'docs', 'security.md');
// nginx の `client_max_body_size 26m;` から値と単位を取り出すための走査パターン。
// **単位は大文字小文字を問わず、k / m / g と単位なし (バイト) をすべて受ける** —
// `1M` のように書かれた値を拾い損ねると、51 倍小さい設定が検査を素通りする (実測で再現)
const NGINX_BODY_SIZE_PATTERN = /client_max_body_size\s+(\d+)\s*([kmg]?)\s*;/i;
// nginx の location 行から経路を取り出すためのパターン
const NGINX_LOCATION_PATTERN = /^\s*location\s+(\S+)\s*\{/;
// nginx のサイズ表記の単位と倍率 (小文字に正規化してから引く)
const NGINX_SIZE_UNIT_MULTIPLIERS: Record<string, number> = {
  '': 1,
  k: 1024,
  m: 1024 * 1024,
  g: 1024 * 1024 * 1024,
};
// 経路上限ごとに、設定例のどの枠が効くのかを書いた対応表。
// `location: null` は「個別の location を持たず既定値を継承する」ことを表す。
//
// **値ではなく「どの定数と比べるか」だけを書く**ので、上限を変えてもここは古くならない。
// **全経路を載せるのが要点**: 以前は個別 location を持つ 2 経路しか見ておらず、既定値を
// 継承する経路 (SSO ACS 等) の上限を引き上げても検査が素通りしていた (実測で再現)。
// 載せ忘れは下の完全性テストが落とす。
const NGINX_ROUTE_EXPECTATIONS: {
  limitName: string;
  limitBytes: number;
  location: string | null;
}[] = [
  {
    limitName: 'INBOUND_EMAIL_MAX_BODY_BYTES',
    limitBytes: INBOUND_EMAIL_MAX_BODY_BYTES,
    location: '/api/inbound/email',
  },
  {
    limitName: 'ATTACHMENT_UPLOAD_MAX_BODY_BYTES',
    limitBytes: ATTACHMENT_UPLOAD_MAX_BODY_BYTES,
    location: '/api/tickets',
  },
  {
    limitName: 'TICKET_JSON_MAX_BODY_BYTES',
    limitBytes: TICKET_JSON_MAX_BODY_BYTES,
    location: '/api/tickets',
  },
  {
    limitName: 'LINE_WEBHOOK_MAX_BODY_BYTES',
    limitBytes: LINE_WEBHOOK_MAX_BODY_BYTES,
    location: null,
  },
  {
    limitName: 'STRIPE_WEBHOOK_MAX_BODY_BYTES',
    limitBytes: STRIPE_WEBHOOK_MAX_BODY_BYTES,
    location: null,
  },
  { limitName: 'SSO_ACS_MAX_BODY_BYTES', limitBytes: SSO_ACS_MAX_BODY_BYTES, location: null },
  {
    limitName: 'MAGIC_LINK_CALLBACK_MAX_BODY_BYTES',
    limitBytes: MAGIC_LINK_CALLBACK_MAX_BODY_BYTES,
    location: null,
  },
];
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

// 上限つき読み取り関数の名前。**定義元 (`request-body-limit.ts`) から導出する**ので、
// 読み取り関数を足しても呼び出し検査・別名検査が自動で追随する (手書き一覧だと追随しない)
let boundedReadFunctionNames: string[] = [];

// `ROUTE_MAX_BODY_BYTES` に登録済みの定数名。2 つの検査から参照されるので、
// 構文木の走査と同じく beforeAll で 1 回だけ導出して使い回す
let registeredRouteLimitNameList: string[] = [];

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
  // 導出元の構文木 (走査済みのものを使い回す。読み直すと、走査中にファイルが変わったときに
  // 検査ごとに見ている対象がずれる)
  const sourceFile = parsedSources.find((source) => source.path === ENTRY_MODULE_PATH)?.sourceFile;
  // 見つからなければ登録ゼロとして扱う (落ちる方に倒す)
  if (!sourceFile) return [];
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
  const registered = registeredRouteLimitNameList;
  // 導出元自身が export する枠 (ENTRY_MAX_BODY_BYTES 等) は経路の上限ではないので除外する
  const entry = parsedSources.find((source) => source.path === ENTRY_MODULE_PATH);
  const ownExports = entry ? exportedRouteLimitNames(entry.sourceFile) : [];
  // 登録漏れの定数名を溜める入れ物 (同じ名前を 2 度報告しないよう集合で持つ)
  const missing = new Set<string>();
  // 1 ファイルずつ、公開されている経路上限を見る
  for (const { path, sourceFile } of parsedSources) {
    for (const name of exportedRouteLimitNames(sourceFile)) {
      // 導出元自身の export は経路の上限ではないので飛ばす。
      // **「導出元のファイルであること」まで見るのが要点** — 名前だけで除外すると、
      // 別のモジュールが `ENTRY_MAX_BODY_BYTES` 等の名前を借りるだけで登録義務から
      // 抜けられてしまい、入口の枠が追随しないまま静かな切り詰めが戻る
      if (path === ENTRY_MODULE_PATH && ownExports.includes(name)) continue;
      // 一覧に完全一致で載っていなければ登録漏れ
      if (!registered.includes(name)) missing.add(name);
    }
  }
  // 失敗時のメッセージを安定させるため並べ替えて返す
  return [...missing].sort();
}

/**
 * 定義元 (`request-body-limit.ts`) が export している上限つき読み取り関数の名前を返す。
 *
 * **手書きの一覧を置き換えるための導出。** 呼び出し検査も別名検査も「関数名」を手掛かりに
 * するので、一覧から漏れた関数は検査そのものが素通りする (漏れは見逃す方向に倒れるため
 * 気付けない)。定義元を読んで命名規約に合う export をすべて拾えば、読み取り関数を足しても
 * 検出網が自動で追随する。
 *
 * **書き方を問わず拾う。** 関数宣言 (`export async function readXWithinByteLimit`)、
 * 変数への代入 (`export const readXWithinByteLimit = async () => {}`)、宣言と分けた公開
 * (`export { readXWithinByteLimit }`) のいずれも見る。関数宣言だけを見ていると、
 * アロー関数で書かれたヘルパーが一覧に入らず、その呼び出しが検出網を素通りする
 * (実測で再現。名前の付け方だけで検査対象から外れるのは、この導出の目的に反する)。
 */
function exportedBoundedReadFunctionNames(): string[] {
  // 定義元の構文木 (走査済みのものを使い回す)
  const sourceFile = parsedSources.find(
    (source) => source.path === BOUNDED_READ_MODULE_PATH,
  )?.sourceFile;
  // 見つからなければ空で返す (下の「空でない」テストが落ちて異常に気付ける)
  if (!sourceFile) return [];
  // 見つけた関数名を溜める入れ物 (同じ名前を 2 度持たないよう集合で持つ)
  const names = new Set<string>();
  // 構文木をたどって export を探す
  visitNodes(sourceFile, (node) => {
    // `export function X() {}` / `export async function X() {}` の形
    if (ts.isFunctionDeclaration(node) && node.name) {
      // export 修飾子が付いていなければ対象外 (公開されていない関数は呼び出し側から使えない)
      const isExported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      // 付いていて、命名規約に合えば拾う
      if (isExported && BOUNDED_READ_FUNCTION_NAME_PATTERN.test(node.name.text))
        names.add(node.name.text);
      return;
    }
    // `export const X = async () => {}` / `export const X = function () {}` の形。
    // 関数宣言と等価に扱う (書き方の違いで検査対象から外れないようにする)
    if (ts.isVariableStatement(node)) {
      // export 修飾子が付いていなければ対象外
      const isExported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      // 付いていなければ何もしない
      if (!isExported) return;
      // 宣言された名前を順に見る
      for (const declaration of node.declarationList.declarations) {
        // 名前が識別子でなければ (分割代入など) 関数名として扱えない
        if (!ts.isIdentifier(declaration.name)) continue;
        // 命名規約に合わなければ関係ない
        if (!BOUNDED_READ_FUNCTION_NAME_PATTERN.test(declaration.name.text)) continue;
        // 中身が関数かどうかを見る。`as` などで包まれていても中の式まで辿る
        let initializer = declaration.initializer;
        while (
          initializer &&
          (ts.isAsExpression(initializer) || ts.isParenthesizedExpression(initializer))
        )
          initializer = initializer.expression;
        // 関数式・アロー関数なら読み取り関数とみなして拾う
        if (
          initializer &&
          (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
        )
          names.add(declaration.name.text);
      }
      return;
    }
    // `export { X }` の形 (宣言と公開を分けた場合)
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      // 公開される名前 (別名があれば別名) を順に見る
      for (const element of node.exportClause.elements) {
        // 命名規約に合えば拾う
        if (BOUNDED_READ_FUNCTION_NAME_PATTERN.test(element.name.text))
          names.add(element.name.text);
      }
    }
  });
  // 失敗時のメッセージを安定させるため並べ替えて返す
  return [...names].sort();
}

/**
 * `docs/security.md` §7 の nginx 設定例が、経路側の上限を下回っている箇所を返す
 * (空なら全経路で「前段の枠 ≧ アプリの枠」が成立している)。
 *
 * **ここだけが人手の約束のまま残っていたので機械化する。** 入口の枠はコードから導出されるが、
 * 前段プロキシの `client_max_body_size` はドキュメントへの直書きなので、経路上限を引き上げても
 * 追随しない。実際 `MAX_ATTACHMENT_SIZE_BYTES` を倍にしても全テストは緑のままで、
 * ドキュメントだけが古くなった。その状態で配備すると、上限内の正規リクエストが前段で切られ、
 * ブラウザには原因の分からない接続断として見える (`src/domain/attachment.ts` の事前検査が
 * 避けようとしている失敗そのもの)。
 *
 * 比較は「下回っていないこと」だけを見る。設定例は経路の上限に余裕を足した値なので、
 * 余裕の取り方 (現状 +1MB) まで固定すると、余裕を見直すだけで落ちる変更検知になってしまう。
 */
function parseNginxBodySizes(): {
  defaultBytes: number | undefined;
  byLocation: Map<string, number>;
} {
  // ドキュメントを 1 行ずつ読む (対象は §7 の短い設定例だけなので素朴な走査で足りる)
  const lines = readFileSync(SECURITY_DOC_PATH, 'utf8').split('\n');
  // location の外に置かれた既定値 (見つからなければ undefined)
  let defaultBytes: number | undefined;
  // location ごとに明示された値
  const byLocation = new Map<string, number>();
  // いま読んでいる行がどの location の中にいるか (location の外なら undefined)
  let currentLocation: string | undefined;
  // 1 行ずつ見る
  for (const line of lines) {
    // location の開始行なら、以降のサイズ指定はその経路のものとして扱う
    const locationMatch = line.match(NGINX_LOCATION_PATTERN);
    if (locationMatch) currentLocation = locationMatch[1];
    // 閉じ括弧だけの行なら location を抜けたとみなす
    if (line.trim() === '}') {
      currentLocation = undefined;
      continue;
    }
    // サイズ指定が無ければ次の行へ
    const sizeMatch = line.match(NGINX_BODY_SIZE_PATTERN);
    if (!sizeMatch) continue;
    // 単位 (k/m/g、無指定はバイト) を倍率に直す。大文字で書かれていても同じ扱いにする
    const multiplier = NGINX_SIZE_UNIT_MULTIPLIERS[sizeMatch[2].toLowerCase()];
    // 想定外の単位なら読み飛ばさず 0 として扱う (小さく倒して検査が落ちる側へ)
    const bytes = Number(sizeMatch[1]) * (multiplier ?? 0);
    // location の中なら経路ごとの値、外なら既定値として覚える
    if (currentLocation) byLocation.set(currentLocation, bytes);
    else defaultBytes = bytes;
  }
  // 読み取った枠を返す
  return { defaultBytes, byLocation };
}

/**
 * `docs/security.md` §7 の nginx 設定例が、経路側の上限を下回っている箇所を返す
 * (空なら全経路で「前段の枠 ≧ アプリの枠」が成立している)。
 *
 * **ここだけが人手の約束のまま残っていたので機械化する。** 入口の枠はコードから導出されるが、
 * 前段プロキシの `client_max_body_size` はドキュメントへの直書きなので、経路上限を引き上げても
 * 追随しない。実際 `MAX_ATTACHMENT_SIZE_BYTES` を倍にしても全テストは緑のままで、
 * ドキュメントだけが古くなった。その状態で配備すると、上限内の正規リクエストが前段で切られ、
 * ブラウザには原因の分からない接続断として見える (`src/domain/attachment.ts` の事前検査が
 * 避けようとしている失敗そのもの)。
 *
 * **全経路を見る。** 個別の `location` を持つ経路はその値と、持たない経路は既定値と比べる
 * (nginx の継承と同じ考え方)。個別 location から `client_max_body_size` が消えた場合も
 * 既定値との比較に落ちるので、指定が丸ごと消える退行を取りこぼさない。
 *
 * 比較は「下回っていないこと」だけを見る。設定例は経路の上限に余裕を足した値なので、
 * 余裕の取り方 (現状 +1MB) まで固定すると、余裕を見直すだけで落ちる変更検知になってしまう。
 */
function staleNginxBodySizes(): string[] {
  // 設定例から既定値と location ごとの値を読み取る
  const { defaultBytes, byLocation } = parseNginxBodySizes();
  // 違反を溜める入れ物
  const offenders: string[] = [];
  // 既定値が見つからなければ、既定を継承する経路が一切検査できないので違反にする
  if (defaultBytes === undefined)
    offenders.push('docs/security.md §7 に既定の client_max_body_size がありません');
  // 経路ごとに、効いている枠が上限を下回っていないか見る
  for (const expectation of NGINX_ROUTE_EXPECTATIONS) {
    // 個別 location の値。無ければ nginx と同じく既定値を継承する
    const effectiveBytes =
      (expectation.location ? byLocation.get(expectation.location) : undefined) ?? defaultBytes;
    // 既定値も無ければ上で報告済みなので、ここでは次へ
    if (effectiveBytes === undefined) continue;
    // 上限を下回っていれば違反として記録する
    if (effectiveBytes < expectation.limitBytes)
      offenders.push(
        `${expectation.location ?? '(既定)'}: docs は ${effectiveBytes} バイトだが ` +
          `${expectation.limitName} は ${expectation.limitBytes} バイト`,
      );
  }
  // 失敗時のメッセージを安定させるため並べ替えて返す
  return offenders.sort();
}

/**
 * 読み取り関数のモジュールを**名前空間として取り込んでいる**箇所を返す (空なら違反なし)。
 *
 * **個別の抜け道を潰し続けるのをやめるための、構造的な封じ手。**
 * 呼び出し検査は「呼び出している関数名」を手掛かりにするので、名前空間オブジェクトを一度
 * 手元に持たれると、そこから名前を付け替える方法がいくらでも生える:
 *   - `const read = rbl.readBodyWithinByteLimit;`（プロパティアクセスでの捕捉）
 *   - `const { readFormWithinByteLimit: readForm } = rbl;`（分割代入での改名）
 *   - `const read = rbl['readBodyWithinByteLimit'];`（要素アクセス）
 * いずれも呼び出し側の識別子が別名になるため検査を素通りする (実測で 3 形とも再現した)。
 * 形ごとに検査を足していくと同じ種類の穴が出続けるので、**入口である名前空間 import 自体を
 * 禁じて**手掛かりが失われる経路をまとめて断つ。名前付き import (`import { readX }`) は
 * 別名禁止と併せて名前が保たれるので、そちらだけを使う。
 */
function boundedReadNamespaceImports(): string[] {
  // 違反 (ファイルと束縛名) を溜める入れ物
  const offenders: string[] = [];
  // 1 ファイルずつ import 宣言を見る
  for (const { path, sourceFile } of parsedSources) {
    // 定義元自身は対象外
    if (path === BOUNDED_READ_MODULE_PATH) continue;
    visitNodes(sourceFile, (node) => {
      // import 宣言でなければ関係ない
      if (!ts.isImportDeclaration(node)) return;
      // 読み取り関数のモジュールを指していなければ関係ない
      if (!ts.isStringLiteral(node.moduleSpecifier)) return;
      if (!node.moduleSpecifier.text.includes(BOUNDED_READ_MODULE_SPECIFIER)) return;
      // `import * as ns from '...'` の形だけを違反として拾う
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings))
        offenders.push(`${path}: import * as ${bindings.name.text}`);
    });
  }
  // 失敗時のメッセージを安定させるため並べ替えて返す
  return offenders.sort();
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
        if (!original || !boundedReadFunctionNames.includes(original)) continue;
        // 別名を付けているので違反として記録する
        offenders.push(`${path}: ${original} as ${element.name.text}`);
      }
    });
  }
  // 失敗時のメッセージを安定させるため並べ替えて返す
  return offenders.sort();
}

/**
 * ファイル内で **import によって束縛されているローカル名**をすべて返す。
 *
 * 上限として渡された識別子が「よそから持ち込んだ定数」なのか「その場で作ったローカル変数」なのかを
 * 見分けるために使う。名前だけを登録一覧と突き合わせると、
 * `const STRIPE_WEBHOOK_MAX_BODY_BYTES = 500 * 1024 * 1024;` のように**登録済みの名前を
 * 借りたローカル定数**が素通りしてしまう (export していないので登録漏れ検出にも掛からない。
 * 実測で再現した)。import 由来であることまで求めれば、その借用を塞げる。
 */
function importedBindingNames(sourceFile: ts.SourceFile): Set<string> {
  // 束縛されたローカル名を溜める入れ物
  const names = new Set<string>();
  // 構文木をたどって import 宣言を探す
  visitNodes(sourceFile, (node) => {
    // import 宣言でなければ関係ない
    if (!ts.isImportDeclaration(node) || !node.importClause) return;
    // `import X from '...'` の既定 import
    if (node.importClause.name) names.add(node.importClause.name.text);
    // 名前付き / 名前空間の取り込み
    const bindings = node.importClause.namedBindings;
    // 無ければここまで
    if (!bindings) return;
    // `import * as ns from '...'` の形
    if (ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
    // `import { A, B as C } from '...'` の形 (束縛されるのはローカル側の名前)
    else for (const element of bindings.elements) names.add(element.name.text);
  });
  // 集めた名前を返す
  return names;
}

/**
 * 上限つき読み取り関数を**ローカル変数へ捕まえている**箇所を返す (空なら違反なし)。
 *
 * 呼び出し検査は「呼び出している名前」を手掛かりにするので、
 * `const read = rbl.readBodyWithinByteLimit;` と一度受けてから `read(req, 500 * 1024 * 1024)` と
 * 書かれると、呼び出し側の識別子が `read` になって検査を素通りする (別名 import の検査も
 * `X as Y` の形しか見ないので掛からない。実測で再現した)。
 * 別名 import を禁じているのと同じ理由で、変数への捕捉も禁じて手掛かりを守る。
 */
function boundedReadCapturedIntoLocals(): string[] {
  // 違反 (ファイルと書かれている式) を溜める入れ物
  const offenders: string[] = [];
  // 1 ファイルずつ変数宣言を見る
  for (const { path, sourceFile } of parsedSources) {
    // 定義元自身は対象外 (内部で自分の関数を参照するのは当然のため)
    if (path === BOUNDED_READ_MODULE_PATH) continue;
    visitNodes(sourceFile, (node) => {
      // 変数宣言でなければ関係ない
      if (!ts.isVariableDeclaration(node) || !node.initializer) return;
      // 分割代入 (`const { readFormWithinByteLimit: readForm } = rbl;`) の形。
      // 取り出し元が何であれ、読み取り関数の名前を取り出していれば捕捉とみなす
      if (ts.isObjectBindingPattern(node.name)) {
        // 取り出している要素を順に見る
        for (const element of node.name.elements) {
          // 元のプロパティ名 (改名していなければ束縛名がそのまま元の名前)
          const propertyName = element.propertyName ?? element.name;
          // 識別子でなければ判定できない
          if (!ts.isIdentifier(propertyName)) continue;
          // 読み取り関数を取り出していれば違反として記録する
          if (boundedReadFunctionNames.includes(propertyName.text))
            offenders.push(`${path}: ${node.getText(sourceFile)}`);
        }
        return;
      }
      // 初期化式が「読み取り関数そのものへの参照」かどうかを見る
      const initializer = node.initializer;
      // 素の識別子 (`const read = readBodyWithinByteLimit;`)
      const referencedName = ts.isIdentifier(initializer)
        ? initializer.text
        : // 名前空間経由 (`const read = rbl.readBodyWithinByteLimit;`)
          ts.isPropertyAccessExpression(initializer) && ts.isIdentifier(initializer.name)
          ? initializer.name.text
          : // 要素アクセス経由 (`const read = rbl['readBodyWithinByteLimit'];`)
            ts.isElementAccessExpression(initializer) &&
              ts.isStringLiteral(initializer.argumentExpression)
            ? initializer.argumentExpression.text
            : undefined;
      // 読み取り関数を指していなければ問題なし
      if (!referencedName || !boundedReadFunctionNames.includes(referencedName)) return;
      // 捕捉しているので違反として記録する
      offenders.push(`${path}: ${node.getText(sourceFile)}`);
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
 *
 * **名前の一致だけでは足りず、import 由来であることまで求める。** 登録済みの名前を借りた
 * ローカル定数 (`const STRIPE_WEBHOOK_MAX_BODY_BYTES = 500 * 1024 * 1024;`) を書かれると、
 * 名前の突き合わせは通ってしまい (b) がそのまま復活する (実測で再現)。
 */
function boundedReadCallsWithUnregisteredLimit(): string[] {
  // 一覧に登録済みの定数名
  const registered = registeredRouteLimitNameList;
  // 違反 (ファイルと渡された式) を溜める入れ物
  const offenders = new Set<string>();
  // 1 ファイルずつ呼び出しを見る
  for (const { path, sourceFile } of parsedSources) {
    // 読み取り関数そのものを定義しているモジュールは対象外。ここでの `maxBytes` は
    // 呼び出し元から受け取った引数を転送しているだけで、経路の上限ではない
    if (path === BOUNDED_READ_MODULE_PATH) continue;
    // このファイルが import で束縛しているローカル名 (上限がよそ由来かの判定に使う)
    const imported = importedBindingNames(sourceFile);
    visitNodes(sourceFile, (node) => {
      // 呼び出し式でなければ関係ない
      if (!ts.isCallExpression(node)) return;
      // 呼び出している名前を取り出す。**`ns.readBodyWithinByteLimit(...)` の形も見る** —
      // 名前空間 import (`import * as ns from '...'`) 経由だと呼び出しが
      // `PropertyAccessExpression` になり、識別子だけを見ていると丸ごと素通りする
      // (実際にその形で 500MB の直渡しが検出網を抜けることを確認した)
      const callee = node.expression;
      const calleeName = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)
          ? callee.name.text
          : undefined;
      // 対象関数でなければ関係ない
      if (!calleeName || !boundedReadFunctionNames.includes(calleeName)) return;
      // 第 2 引数 (maxBytes) を取り出す。無ければ型エラーになる形だが、念のため違反扱いにする
      const maxBytesArgument = node.arguments[1];
      if (!maxBytesArgument) {
        offenders.add(`${path}: ${calleeName}(...) に上限が渡されていません`);
        return;
      }
      // 識別子で、登録済みの名前で、**かつ import 由来**ならよい
      // (import を求めるのは、登録済みの名前を借りたローカル定数を弾くため)
      if (
        ts.isIdentifier(maxBytesArgument) &&
        registered.includes(maxBytesArgument.text) &&
        imported.has(maxBytesArgument.text)
      )
        return;
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
    // 読み取り関数の名前は解析済みの構文木から導出する (手書き一覧にしない)
    boundedReadFunctionNames = exportedBoundedReadFunctionNames();
    registeredRouteLimitNameList = registeredRouteLimitNames();
  });

  it('上限つき読み取り関数を定義元から拾えている', () => {
    // **検出網が空になっていないことを先に確かめる。** 呼び出し検査も別名検査もこの一覧を
    // 手掛かりにしているので、命名規約の変更などで 1 つも拾えなくなると、両検査が「違反ゼロ」を
    // 返したまま**何も見ていない**状態になる (見逃す方向の失敗なので他のテストでは気付けない)。
    // 具体的な関数名を書き並べないのは、それでは結局手書き一覧に戻ってしまうため
    expect(boundedReadFunctionNames.length).toBeGreaterThan(0);
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
    // chunked 転送の超過が 413 ではなく 400 に化ける。
    // **「以上」ではなく「超える」ことを求めるのは意図的な保守**。保証に必要なのは
    // 「余白 ≧ ソケット読み取り 1 回分」だが (導出は `ENTRY_OVER_LIMIT_MARGIN_MIN_BYTES` の
    // docstring)、境界ちょうどを許すと読み取り 1 回分の見積もりが 1 バイトでも甘かったときに
    // 保証が崩れるため、1 段厳しい側で固定する。
    // 実際の値 (1MB) は「将来 highWaterMark が変わっても効く余裕」として厚めに取ってあるが、
    // リテラルまで固定すると余裕を見直すだけで落ちる変更検知になるので、下限だけを縛る
    expect(ENTRY_OVER_LIMIT_MARGIN_BYTES).toBeGreaterThan(ENTRY_OVER_LIMIT_MARGIN_MIN_BYTES);
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
    // next.config.ts を Next.js と同じ方法で読み込む (失敗すれば例外でこのテストが落ちる)
    const loaded = await transpileConfig({ nextConfigPath: NEXT_CONFIG_PATH, dir: REPO_ROOT });
    // **戻り値の形が 2 通りあるので Next.js と同じようにほどく。** 従来経路では
    // モジュール名前空間 (`.default` を持つ) が返るが、ネイティブの TS ローダが有効な経路
    // (`__NEXT_NODE_NATIVE_TS_LOADER_ENABLED`) では設定オブジェクトそのものが返る。
    // Next.js 自身も `interopDefault` で両方を受けている (`next/dist/server/config.js`)。
    //
    // **現状このリポジトリでは常に従来経路になる**ので、これは予防的な受けである:
    // ネイティブ経路は Node の ESM 解決をそのまま使うため、`@/` エイリアスも拡張子なしの
    // 相対 import も解決できず、必ず警告を出して従来経路へフォールバックする (実測で確認)。
    // 連鎖の全ファイルに `.ts` を付けて `allowImportingTsExtensions` を有効にすれば
    // ネイティブ経路に載るが、tsconfig 全体に影響する変更なので見送っている。
    // その前提が変わったときに `.default` 決め打ちで偽の赤を出さないよう、両方受けておく
    const config = loaded.default ?? loaded;
    // 読み込めた設定が、導出した枠をそのまま渡していることまで確認する
    expect(config?.experimental?.proxyClientMaxBodySize).toBe(ENTRY_MAX_BODY_BYTES);
  });

  it('src/ 配下の経路上限がすべて ROUTE_MAX_BODY_BYTES に登録されている', () => {
    // 導出元の一覧に載っていない上限があると、その経路だけ入口で切り詰められる。
    // 「足したら登録する」を人手の約束にせず、ここで機械的に落とす
    expect(unregisteredRouteLimitNames()).toEqual([]);
  });

  it('全経路が前段プロキシの対応表に載っている', () => {
    // 対応表から漏れた経路はドキュメントの検査が素通りする (漏れは見逃す方向に倒れる)。
    // 登録一覧と突き合わせて、載せ忘れを機械的に落とす
    const mapped = NGINX_ROUTE_EXPECTATIONS.map((e) => e.limitName).sort();
    expect(mapped).toEqual([...registeredRouteLimitNameList].sort());
  });

  it('docs/security.md の前段プロキシ設定が経路の上限を下回っていない', () => {
    // 前段の枠がアプリの枠より小さいと、上限内の正規リクエストがアプリに届く前に切られる。
    // ここが唯一の手書き転記なので、比較だけは機械的に固定しておく
    expect(staleNginxBodySizes()).toEqual([]);
  });

  it('読み取り関数のモジュールが名前空間 import されていない', () => {
    // 名前空間オブジェクトを手元に持たれると、そこから名前を付け替える手が無数に生える
    // (プロパティアクセス / 分割代入 / 要素アクセス)。入口ごと禁じてまとめて断つ
    expect(boundedReadNamespaceImports()).toEqual([]);
  });

  it('上限つき読み取り関数が別名で import されていない', () => {
    // 別名を付けられると呼び出し検査 (関数名が手掛かり) が丸ごと素通りする
    expect(boundedReadAliasImports()).toEqual([]);
  });

  it('上限つき読み取り関数がローカル変数に捕まえられていない', () => {
    // 一度変数で受けてから呼ぶと、呼び出し側の識別子が別名になって呼び出し検査を素通りする。
    // 別名 import を禁じているのと同じ理由で、変数への捕捉も禁じる
    expect(boundedReadCapturedIntoLocals()).toEqual([]);
  });

  it('上限つき読み取りの呼び出しが登録済みの定数だけを上限に使っている', () => {
    // 数値リテラルの直渡しや、export しないローカル定数を上限にすると、上の登録漏れ検出
    // (export された名前が手掛かり) に引っかからず、その経路だけ入口の枠が追随しないまま
    // 静かに切り詰められる。「使ってよいのは登録済みの名前だけ」の形にして両方を塞ぐ
    expect(boundedReadCallsWithUnregisteredLimit()).toEqual([]);
  });
});
