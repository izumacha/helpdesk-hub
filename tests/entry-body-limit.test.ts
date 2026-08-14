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
//   (b) どこかの経路の上限を引き上げたのに入口の枠が追随していない状態
//       (導出をやめて直書きに戻した場合に起きる)。
//   (c) 新しい経路の上限を足したのに `ROUTE_MAX_BODY_BYTES` へ登録し忘れた状態
//       (登録が人手の約束のままだと、静かな切り詰めがそのまま再発する)。

// Vitest の DSL
import { describe, expect, it } from 'vitest';
// ソースを走査して「上限の定義漏れ」を拾うため (Node 標準の同期 API で十分)
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
// 入口の枠と、Next.js の既定値 (設定しないとどうなるかを示すための参照値)
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
// Next.js 自身の手順で読み込めるか試す設定ファイル
const NEXT_CONFIG_PATH = join(REPO_ROOT, 'next.config.ts');
// 上限つき読み取り関数の定義元 (呼び出し側の検査では対象外にする)
const BOUNDED_READ_MODULE_PATH = join(SRC_DIR, 'lib', 'request-body-limit.ts');
// 経路上限の命名規約。この名前で export されたものを「経路の上限」とみなす。
// **`*_MAX_BODY_BYTES` という命名に乗っていることが検出の前提**で、`MAX_UPLOAD_BYTES` のように
// 規約から外れた名前は拾えない (拾えないと入口の枠が追随せず、静かな切り詰めが戻る)。
// 新しい経路上限はこの命名に揃えること。
const ROUTE_LIMIT_DECLARATION_PATTERN = /^export const ([A-Z0-9_]*_MAX_BODY_BYTES)\b/gm;
// 宣言と分けて公開する形 (`export { FOO_MAX_BODY_BYTES }` / バレル経由の再 export) も拾う。
// 宣言だけを見ていると、この形で足された上限が検出網を素通りする
const ROUTE_LIMIT_EXPORT_BLOCK_PATTERN = /export\s*\{([^}]*)\}/g;
// export ブロックの中に並ぶ名前のうち、経路上限の命名に合うもの
const ROUTE_LIMIT_NAME_PATTERN = /\b([A-Z0-9_]*_MAX_BODY_BYTES)\b/g;

/**
 * コメントを取り除いたソースを返す (中身は同じ長さの空白に置き換える)。
 *
 * **本リポジトリではコメントを外さないと誤検知する。** CLAUDE.md §5 が 1 行ごとの日本語
 * コメントを求めているため、`readFormWithinByteLimit()` のような字面が解説文に出てくるのは
 * 普通のこと (実際 src/ 配下に 7 箇所ある)。それを呼び出しとして拾うと、引数が無いので
 * 「解析できなかった」= 違反として報告され、**コメントを書いただけでテストが落ちる**。
 *
 * **正規表現ではなく 1 文字ずつ状態を持って走査する。** 単純な正規表現だと
 * `'http://localhost:3000'` の `//` をコメント開始と誤認して行末までを消してしまい、
 * 同じ行にある宣言や呼び出しごと検出網から落ちる (実際に `app-url.ts` と `saml.ts` の
 * 2 箇所が壊れていた)。文字列・テンプレートリテラルの中は消さないようにする。
 * 長さを保つために空白へ置き換えるのは、元のソースと位置がずれないようにするため。
 *
 * 正規表現リテラル (`/.../`) までは区別しない。ただし `/*` を見つけたときは**閉じ記号が
 * 存在する場合だけ**コメントとして扱う — そうしないと `/[/*]+/` のような文字クラスを
 * コメント開始と誤認し、ファイル末尾まで塗り潰して以降の検出を黙って落としてしまう。
 * 閉じ記号がある形で誤認した場合は、カッコの対応が崩れて「解析できない」= 失敗側に倒れる。
 */
function stripComments(source: string): string {
  // 出力を 1 文字ずつ組み立てる入れ物
  const out: string[] = [];
  // 今どの構文の中にいるか
  let state: 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'template' = 'code';
  // 文字列の中でバックスラッシュ直後かどうか (エスケープされた引用符で抜けないため)
  let escaped = false;
  // 先頭から 1 文字ずつ見る
  for (let i = 0; i < source.length; i++) {
    // 今の 1 文字と次の 1 文字 (2 文字の記号を判定するため)
    const char = source[i];
    const next = source[i + 1] ?? '';
    // コメントの中にいるなら、改行と閉じ記号だけを見て空白を書く
    if (state === 'line-comment') {
      // 改行でコメントは終わり (改行自体は残す)
      if (char === '\n') {
        state = 'code';
        out.push(char);
      } else out.push(' ');
      continue;
    }
    if (state === 'block-comment') {
      // `*/` で終わり。2 文字とも空白にするため i を 1 つ進める
      if (char === '*' && next === '/') {
        state = 'code';
        out.push('  ');
        i++;
      } else out.push(char === '\n' ? char : ' ');
      continue;
    }
    // 文字列・テンプレートの中にいるなら、そのまま書き写して閉じ記号だけ見る
    if (state === 'single' || state === 'double' || state === 'template') {
      // 直前がバックスラッシュならエスケープなので閉じ判定をしない
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (
        (state === 'single' && char === "'") ||
        (state === 'double' && char === '"') ||
        (state === 'template' && char === '`')
      ) {
        state = 'code';
      }
      out.push(char);
      continue;
    }
    // ここから下はコード部分。コメント・文字列の開始を見る
    if (char === '/' && next === '/') {
      state = 'line-comment';
      out.push('  ');
      i++;
      continue;
    }
    if (char === '/' && next === '*') {
      // **閉じ記号が無いなら、ブロックコメントではないとみなす。** 正規表現リテラルの
      // 文字クラス (`/[/*]+/` など) にも `/` `*` の並びは現れる。これをコメント開始と
      // 誤認すると、閉じ記号が見つからないままファイル末尾まで空白で塗り潰され、
      // **以降の宣言も呼び出しも検出網から黙って消える** (実際にその形で退行を作れた)。
      // 見逃しは最も避けたい失敗なので、閉じ記号の有無で先に切り分ける
      if (source.indexOf('*/', i + 2) === -1) {
        out.push(char);
        continue;
      }
      state = 'block-comment';
      out.push('  ');
      i++;
      continue;
    }
    if (char === "'") state = 'single';
    else if (char === '"') state = 'double';
    else if (char === '`') state = 'template';
    // コードはそのまま書き写す
    out.push(char);
  }
  // 組み立てた文字列を返す
  return out.join('');
}

/**
 * 1 ファイルのソースから、経路上限として公開されている定数名をすべて拾う。
 *
 * 宣言 (`export const X = ...`) と、宣言と分けた公開 (`export { X }`) の 2 形式を見る。
 * 同じ名前が両方で出てくることがあるので呼び出し側で重複を許す前提にしてある。
 */
function exportedRouteLimitNames(rawSource: string): string[] {
  // 解説コメントに書かれた同じ字面を宣言・公開と取り違えないよう、先にコメントを落とす
  // (これを怠ると、コメント 1 行で未登録の上限が「登録済み」に化けたり、逆にコメントを
  //  書いただけでテストが落ちたりする。どちらも実際に起きることを確認済み)
  const source = stripComments(rawSource);
  // 宣言形式で公開されている名前
  const declared = [...source.matchAll(ROUTE_LIMIT_DECLARATION_PATTERN)].map((m) => m[1]);
  // export ブロック形式で公開されている名前 (ブロックの中身だけを対象にする)
  const reExported = [...source.matchAll(ROUTE_LIMIT_EXPORT_BLOCK_PATTERN)].flatMap((block) =>
    [...block[1].matchAll(ROUTE_LIMIT_NAME_PATTERN)].map((m) => m[1]),
  );
  // 両方をまとめて返す
  return [...declared, ...reExported];
}
// 導出元の一覧 (`const ROUTE_MAX_BODY_BYTES = [ ... ] as const;`) を切り出すためのパターン
const REGISTRY_BLOCK_PATTERN = /const ROUTE_MAX_BODY_BYTES = \[([\s\S]*?)\] as const;/;
// 一覧の中に 1 行ずつ並ぶ定数名 (末尾のカンマまでを 1 要素とみなす)
const REGISTRY_ENTRY_PATTERN = /^\s*([A-Z0-9_]+),/gm;

/**
 * 導出元の `ROUTE_MAX_BODY_BYTES` に**実際に登録されている**定数名を返す。
 *
 * ソース全体への部分一致ではなく配列の中身だけを見るのが要点。全体一致にすると
 * (a) 既存名の部分文字列 (`EMAIL_MAX_BODY_BYTES` が `INBOUND_EMAIL_MAX_BODY_BYTES` に一致) や
 * (b) コメント中に名前が出てくるだけ、でも「登録済み」と誤判定してしまい、
 * 下の登録漏れ検出がすり抜ける (どちらも実際にすり抜けることを確認済み)。
 */
function registeredRouteLimitNames(entrySource: string): string[] {
  // 配列リテラルの中身だけを切り出す
  const block = entrySource.match(REGISTRY_BLOCK_PATTERN);
  // 一覧そのものが見つからない = 導出の形が変わったということなので、登録ゼロとして落とす
  if (!block) return [];
  // 各行の先頭に並ぶ定数名を拾う
  return [...block[1].matchAll(REGISTRY_ENTRY_PATTERN)].map((m) => m[1]);
}

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

/**
 * 走査対象のソースファイル (`src/` 配下の .ts / .tsx。生成物は除く) を絶対パスで返す。
 *
 * `.tsx` も見るのは、上限がコンポーネント側 (フォームの事前検査など) に置かれても
 * 検出網から外れないようにするため。
 */
function sourceFiles(): string[] {
  // src/ 配下を再帰的にたどり、対象拡張子だけを絶対パスにして返す
  return readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
    .filter((rel) => (rel.endsWith('.ts') || rel.endsWith('.tsx')) && !isGeneratedPath(rel))
    .map((rel) => join(SRC_DIR, rel));
}

// 上限つき読み取りの呼び出し位置を見つけるためのパターン (引数の切り出しは下の関数が行う)
const BOUNDED_READ_CALL_PATTERN = /read(?:Body|Form|Text)WithinByteLimit\(/g;
// 解析できなかった呼び出しに付ける印。**規約違反と同じ扱いで報告する** (§9 fail-closed:
// 読めなかったものを「問題なし」に倒すと、検出網に穴が開いたことに気付けない)
const UNPARSABLE_CALL_MARKER = '<引数を解析できませんでした>';

/**
 * 呼び出しの第 2 引数 (maxBytes) として書かれている式を、そのままの文字列で返す。
 *
 * 正規表現で引数を切り出すのはやめて、カッコの対応を数えて切り出す。正規表現だと
 * 第 1 引数の形に依存してしまい、`readBodyWithinByteLimit(req.clone(), 200 * 1024 * 1024)` の
 * ように**カッコを含む式**が来た瞬間に呼び出しごとマッチしなくなる = 検出網から丸ごと消える
 * (実際にこの形ですり抜けることを確認済み)。
 *
 * 文字列リテラルやコメントの中のカッコまでは区別しないが、その場合は対応が崩れて
 * 「解析できなかった」側に倒れるので、見逃しではなく失敗として表に出る。
 */
function boundedReadMaxBytesArguments(rawSource: string): string[] {
  // 解説コメントに書かれた同じ字面を呼び出しと取り違えないよう、先にコメントを落とす
  const source = stripComments(rawSource);
  // 見つけた第 2 引数の式を溜める入れ物
  const args: string[] = [];
  // 呼び出しの開始位置を順に見ていく
  for (const match of source.matchAll(BOUNDED_READ_CALL_PATTERN)) {
    // 開きカッコの位置 (マッチの末尾が `(` なので 1 文字戻る)
    const openIndex = (match.index ?? 0) + match[0].length - 1;
    // カッコの深さ (開きカッコで +1、閉じカッコで -1)
    let depth = 0;
    // 引数の区切りになる「深さ 1 のカンマ」の位置
    const separators: number[] = [];
    // 呼び出しを閉じるカッコの位置 (見つからなければ -1 のまま)
    let closeIndex = -1;
    // 開きカッコから順に 1 文字ずつ見て、対応する閉じカッコを探す
    for (let i = openIndex; i < source.length; i++) {
      // 今見ている 1 文字
      const char = source[i];
      // 開きカッコ類なら深さを 1 つ増やす
      if (char === '(' || char === '[' || char === '{') depth++;
      // 閉じカッコ類なら深さを 1 つ減らし、0 に戻ったらそこが呼び出しの終わり
      else if (char === ')' || char === ']' || char === '}') {
        depth--;
        if (depth === 0) {
          closeIndex = i;
          break;
        }
      }
      // 深さ 1 のカンマだけが引数の区切り (入れ子の中のカンマは数えない)
      else if (char === ',' && depth === 1) separators.push(i);
    }
    // 閉じカッコが見つからない / 引数が 1 つしかない場合は解析できなかったものとして報告する
    if (closeIndex === -1 || separators.length === 0) {
      args.push(UNPARSABLE_CALL_MARKER);
      continue;
    }
    // 第 2 引数は「1 つ目のカンマの次」から「2 つ目のカンマ (無ければ閉じカッコ)」まで
    const end = separators.length > 1 ? separators[1] : closeIndex;
    // 前後の空白・改行を落として式そのものを取り出す
    args.push(source.slice(separators[0] + 1, end).trim());
  }
  // 見つかった式をそのまま返す
  return args;
}

/**
 * `readBodyWithinByteLimit` 系へ、**導出元に登録済みの定数以外**を上限として渡している
 * 呼び出しを返す (空なら全呼び出しが登録済みの定数を使っている)。
 *
 * 登録漏れ検出 (下) は export された定数しか見られないため、
 * (a) `readFormWithinByteLimit(req, 100 * 1024 * 1024)` のような数値リテラル直渡し、
 * (b) ルート内に置いた **export しないローカル定数** (命名規約は満たすので名前検査も素通りする)
 * のどちらも、あちらでは捕まらない。**「呼び出しで使ってよいのは登録済みの名前だけ」**という
 * 形にすれば両方まとめて塞げる (どちらも実際にすり抜けることを確認済み)。
 */
function boundedReadCallsWithUnregisteredLimit(files: string[], registered: string[]): string[] {
  // 規約から外れた呼び出しの「渡された式」を溜める入れ物
  const offenders = new Set<string>();
  // 1 ファイルずつ呼び出しを走査する
  for (const file of files) {
    // 読み取り関数そのものを定義しているモジュールは対象外。ここでの `maxBytes` は
    // 呼び出し元から受け取った引数を転送しているだけで、経路の上限ではない
    // (関数シグネチャ自体もこのパターンに一致してしまう)
    if (file === BOUNDED_READ_MODULE_PATH) continue;
    // ファイルの中身を文字列として読む
    const source = readFileSync(file, 'utf8');
    // 呼び出しごとに、上限として渡された式を見る
    for (const maxBytesArgument of boundedReadMaxBytesArguments(source)) {
      // 導出元に登録済みの定数名そのものであればよい
      if (registered.includes(maxBytesArgument)) continue;
      // それ以外は、ファイル名を添えて報告する
      offenders.add(`${file}: ${maxBytesArgument}`);
    }
  }
  // 失敗時のメッセージを安定させるため並べ替えて返す
  return [...offenders].sort();
}

// 上限つき読み取り関数を別名で import している箇所を見つけるためのパターン
// (`import { readTextWithinByteLimit as readBounded } from '...'` と、バレル経由の
// `export { readTextWithinByteLimit as readBounded } from '...'` の両方を見る)
const BOUNDED_READ_ALIAS_IMPORT_PATTERN =
  /(?:im|ex)port\s*\{([^}]*)\}\s*from\s*['"][^'"]*request-body-limit['"]/g;
// import ブロックの中の「元の名前 as 別名」表記
const IMPORT_RENAME_PATTERN = /\b(read(?:Body|Form|Text)WithinByteLimit)\s+as\s+(\w+)/g;

/**
 * 上限つき読み取り関数を**別名で import している**箇所を返す (空なら違反なし)。
 *
 * 呼び出し検査は関数名そのものを手掛かりにしているため、`readBounded(req, 200 * 1024 * 1024)`
 * のように別名を付けられると呼び出しごと検出網から消える。名前を変えられないようにして
 * 手掛かりを守る (別名が必要になったら、まずこの検査の作り直しから考えること)。
 */
function boundedReadAliasImports(files: string[]): string[] {
  // 違反 (ファイルと別名) を溜める入れ物
  const offenders: string[] = [];
  // 1 ファイルずつ import 文を見る
  for (const file of files) {
    // コメント中の例示を拾わないよう、ここでもコメントを落としてから読む
    const source = stripComments(readFileSync(file, 'utf8'));
    // request-body-limit からの import ブロックを順に見る
    for (const block of source.matchAll(BOUNDED_READ_ALIAS_IMPORT_PATTERN)) {
      // ブロックの中に「元の名前 as 別名」があれば違反
      for (const rename of block[1].matchAll(IMPORT_RENAME_PATTERN)) {
        offenders.push(`${file}: ${rename[1]} as ${rename[2]}`);
      }
    }
  }
  // 失敗時のメッセージを安定させるため並べ替えて返す
  return offenders.sort();
}

/**
 * `src/` 配下で `*_MAX_BODY_BYTES` として export されているのに、
 * `ROUTE_MAX_BODY_BYTES` へ登録されていない定数名を返す (空なら登録漏れ無し)。
 *
 * 値ではなく**名前**を突き合わせるのは、各モジュールを動的 import すると
 * 将来重い依存 (Prisma 等) を持つモジュールが混ざったときにテストごと巻き添えになるため。
 */
function unregisteredRouteLimitNames(files: string[]): string[] {
  // 導出元のソース
  const entrySource = readFileSync(ENTRY_MODULE_PATH, 'utf8');
  // 導出元自身が export する枠 (ENTRY_MAX_BODY_BYTES 等) は経路の上限ではないので除外する
  const ownExports = exportedRouteLimitNames(entrySource);
  // 一覧に登録済みの定数名 (完全一致で突き合わせる)
  const registered = registeredRouteLimitNames(entrySource);
  // 登録漏れの定数名を溜める入れ物 (同じ名前を 2 度報告しないよう集合で持つ)
  const missing = new Set<string>();
  // 1 ファイルずつ、経路上限の export を拾って登録状況を見る
  for (const file of files) {
    // ファイルの中身を文字列として読む
    const source = readFileSync(file, 'utf8');
    // 命名規約に合う export をすべて拾う (宣言形式・export ブロック形式の両方)
    for (const name of exportedRouteLimitNames(source)) {
      // 導出元自身の export は経路の上限ではないので飛ばす
      if (ownExports.includes(name)) continue;
      // 一覧に完全一致で載っていなければ登録漏れ
      if (!registered.includes(name)) missing.add(name);
    }
  }
  // 失敗時のメッセージを安定させるため並べ替えて返す
  return [...missing].sort();
}

describe('入口 (proxy) のボディ複製上限', () => {
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
    // chunked 転送の超過が 413 ではなく 400 に化ける。値そのものは上のケースが固定するので、
    // ここは「その値が満たすべき下限」を独立に押さえる
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

  it('src/ 配下の経路上限がすべて ROUTE_MAX_BODY_BYTES に登録されている', () => {
    // 導出元の一覧に載っていない上限があると、その経路だけ入口で切り詰められる。
    // 「足したら登録する」を人手の約束にせず、ここで機械的に落とす
    expect(unregisteredRouteLimitNames(sourceFiles())).toEqual([]);
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

  it('上限つき読み取り関数が別名で import されていない', () => {
    // 別名を付けられると呼び出し検査 (関数名が手掛かり) が丸ごと素通りする
    expect(boundedReadAliasImports(sourceFiles())).toEqual([]);
  });

  it('上限つき読み取りの呼び出しが登録済みの定数だけを上限に使っている', () => {
    // 数値リテラルの直渡しや、export しないローカル定数を上限にすると、上の登録漏れ検出
    // (export された名前が手掛かり) に引っかからず、その経路だけ入口の枠が追随しないまま
    // 静かに切り詰められる。「使ってよいのは登録済みの名前だけ」の形にして両方を塞ぐ
    const registered = registeredRouteLimitNames(readFileSync(ENTRY_MODULE_PATH, 'utf8'));
    expect(boundedReadCallsWithUnregisteredLimit(sourceFiles(), registered)).toEqual([]);
  });
});
