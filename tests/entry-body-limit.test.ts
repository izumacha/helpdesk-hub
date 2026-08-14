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
import { dirname, join } from 'node:path';
// 入口の枠と、Next.js の既定値 (設定しないとどうなるかを示すための参照値)
import {
  ENTRY_MAX_BODY_BYTES,
  ENTRY_OVER_LIMIT_MARGIN_MIN_BYTES,
  NEXT_DEFAULT_ENTRY_MAX_BODY_BYTES,
} from '@/lib/entry-body-limit';
// 実際に Next.js へ渡る設定オブジェクト (文字列一致ではなく値そのものを見る)
import nextConfig from '../next.config';
// 経路別の上限。導出元 (`ROUTE_MAX_BODY_BYTES`) を再利用せず各経路の置き場から個別に import する
// のは、**この対応表そのものを「今どの経路にいくつの枠があるか」の読める一覧として残す**ため。
// 検出力の分担は下の describe を参照 (登録漏れの検出はこの表ではなく完全性テストが担う)
import {
  INBOUND_EMAIL_MAX_BODY_BYTES,
  LINE_WEBHOOK_MAX_BODY_BYTES,
  STRIPE_WEBHOOK_MAX_BODY_BYTES,
} from '@/lib/webhook-body-limits';
import {
  ATTACHMENT_UPLOAD_MAX_BODY_BYTES,
  TICKET_JSON_MAX_BODY_BYTES,
} from '@/lib/ticket-body-limits';
import { SSO_ACS_MAX_BODY_BYTES } from '@/lib/sso-rate-limit';
import { MAGIC_LINK_CALLBACK_MAX_BODY_BYTES } from '@/lib/magic-link';

// 定数名・経路名・上限値の対応表。経路名を添えておくと、失敗したときにどの経路が溢れたのかが分かる。
// **定数名を持たせているのは、この表自体が古びていないことを検査するため** — 表が導出元
// (`ROUTE_MAX_BODY_BYTES`) と食い違うと、新しい経路が下のケース群から丸ごと抜け落ち、
// 「枠を下回らない」「余白がある」の両方が古い最大値のまま通ってしまう
const ROUTE_LIMITS: ReadonlyArray<readonly [string, string, number]> = [
  ['LINE_WEBHOOK_MAX_BODY_BYTES', 'POST /api/inbound/line', LINE_WEBHOOK_MAX_BODY_BYTES],
  ['INBOUND_EMAIL_MAX_BODY_BYTES', 'POST /api/inbound/email', INBOUND_EMAIL_MAX_BODY_BYTES],
  ['STRIPE_WEBHOOK_MAX_BODY_BYTES', 'POST /api/webhooks/stripe', STRIPE_WEBHOOK_MAX_BODY_BYTES],
  [
    'ATTACHMENT_UPLOAD_MAX_BODY_BYTES',
    'POST /api/tickets (multipart)',
    ATTACHMENT_UPLOAD_MAX_BODY_BYTES,
  ],
  ['TICKET_JSON_MAX_BODY_BYTES', 'POST /api/tickets (json)', TICKET_JSON_MAX_BODY_BYTES],
  ['SSO_ACS_MAX_BODY_BYTES', 'POST /api/auth/sso/[tenantId]/acs', SSO_ACS_MAX_BODY_BYTES],
  [
    'MAGIC_LINK_CALLBACK_MAX_BODY_BYTES',
    'POST /api/auth/magic-link/callback',
    MAGIC_LINK_CALLBACK_MAX_BODY_BYTES,
  ],
];

// リポジトリのルート (このテストファイルは <root>/tests/ にあるので 1 つ上)
const REPO_ROOT = join(__dirname, '..');
// 走査対象のソースディレクトリ
const SRC_DIR = join(REPO_ROOT, 'src');
// 導出元 (この一覧に登録されていない上限を落としたい)
const ENTRY_MODULE_PATH = join(SRC_DIR, 'lib', 'entry-body-limit.ts');
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
 * 1 ファイルのソースから、経路上限として公開されている定数名をすべて拾う。
 *
 * 宣言 (`export const X = ...`) と、宣言と分けた公開 (`export { X }`) の 2 形式を見る。
 * 同じ名前が両方で出てくることがあるので呼び出し側で重複を許す前提にしてある。
 */
function exportedRouteLimitNames(source: string): string[] {
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

/**
 * 走査対象のソースファイル (`src/` 配下の .ts / .tsx。生成物は除く) を絶対パスで返す。
 *
 * `.tsx` も見るのは、上限がコンポーネント側 (フォームの事前検査など) に置かれても
 * 検出網から外れないようにするため。
 */
function sourceFiles(): string[] {
  // src/ 配下を再帰的にたどり、対象拡張子だけを絶対パスにして返す
  return readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
    .filter((rel) => (rel.endsWith('.ts') || rel.endsWith('.tsx')) && !rel.startsWith('generated'))
    .map((rel) => join(SRC_DIR, rel));
}

// 行コメント (`// ...`) とブロックコメント (`/* ... */`) を落とすためのパターン
const COMMENT_PATTERN = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

/**
 * コメントを取り除いたソースを返す (中身は同じ長さの空白に置き換える)。
 *
 * **本リポジトリではコメントを外さないと誤検知する。** CLAUDE.md §5 が 1 行ごとの日本語
 * コメントを求めているため、`readFormWithinByteLimit()` のような字面が解説文に出てくるのは
 * 普通のこと (実際 src/ 配下に 7 箇所ある)。それを呼び出しとして拾うと、引数が無いので
 * 「解析できなかった」= 違反として報告され、**コメントを書いただけでテストが落ちる**。
 * 長さを保つために空白へ置き換えるのは、元のソースと位置がずれないようにするため
 * (将来ここで行番号を報告したくなったときに効く)。
 */
function stripComments(source: string): string {
  // コメント部分を、同じ長さの空白列に置き換える
  return source.replace(COMMENT_PATTERN, (matched) => ' '.repeat(matched.length));
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

// import / re-export の指定子 (`from '...'`) を拾うためのパターン
const IMPORT_SPECIFIER_PATTERN = /(?:^|\s)(?:import|export)\b[^;]*?from\s+['"]([^'"]+)['"]/gm;

/**
 * `next.config.ts` から `entry-body-limit.ts` を辿って読まれるモジュールのうち、
 * `@/` エイリアスを使っているものを `ファイル: 指定子` の形で返す (空なら違反なし)。
 *
 * **これは `npm run build` でしか落ちない種類の退行を、その手前で落とすための検査。**
 * Next.js は next.config.ts を独自に transpile して `require` するが、tsconfig の `paths` を
 * 書き換えるのは next.config.ts 自身の import だけで、そこから先の `@/...` は解決されない。
 * ところが `npm run typecheck` は tsconfig の `paths` があるので通り、`npm run test` も
 * vitest の alias 解決で通ってしまう。**速い検査を全部すり抜けて重い e2e ジョブのビルドで
 * 初めて落ちる**ため、ここで機械的に押さえる (実測: `magic-link.ts` の 1 行を `@/` に
 * 戻すと typecheck とユニットテストは通ったまま、config のロードだけが失敗する)。
 */
function aliasImportsInEntryClosure(): string[] {
  // 違反 (ファイルと指定子の組) を溜める入れ物
  const offenders: string[] = [];
  // これから辿るファイルの待ち行列 (起点は導出元モジュール)
  const queue = [ENTRY_MODULE_PATH];
  // 一度辿ったファイルを覚えておく (循環 import で無限ループしないため)
  const visited = new Set<string>();
  // 待ち行列が空になるまで辿る
  while (queue.length > 0) {
    // 次に見るファイル
    const file = queue.pop() as string;
    // すでに見たファイルは飛ばす
    if (visited.has(file)) continue;
    // 見たことを記録する
    visited.add(file);
    // コメント中の `from '@/...'` を拾わないよう、ここでもコメントを落としてから読む
    const source = stripComments(readFileSync(file, 'utf8'));
    // このファイルが持つ import / re-export の指定子を順に見る
    for (const match of source.matchAll(IMPORT_SPECIFIER_PATTERN)) {
      // 指定子 (`./foo` や `@/lib/foo` など)
      const specifier = match[1];
      // エイリアスを使っていたら違反として記録し、その先は辿らない
      if (specifier.startsWith('@/')) {
        offenders.push(`${file}: ${specifier}`);
        continue;
      }
      // 相対指定子でなければ外部パッケージなので辿らない
      if (!specifier.startsWith('.')) continue;
      // 相対指定子を絶対パスの .ts ファイルに直して待ち行列へ積む
      queue.push(join(dirname(file), `${specifier}.ts`));
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
  // 経路ごとに 1 ケース立てる (まとめて 1 ケースにすると、失敗時に溢れた経路が特定しづらい)。
  //
  // **現在の導出 (`max(登録済み) + 余白`) のもとでは、この 7 ケースは恒真である。**
  // 同じ 7 定数から max を取っているので下回りようがない。それでも残しているのは
  // 「導出のしかたが変わったとき」に効かせるため — 例えば誰かが `ENTRY_MAX_BODY_BYTES` を
  // 直書きの数値に戻せば、その値が小さい経路をここが名指しで落とす。
  // 逆に、**登録漏れ (この表に現れない新経路) はここでは絶対に捕まらない**。それは下の
  // 完全性テストの担当で、両者は守備範囲が違う (片方があれば足りる関係ではない)。
  it.each(ROUTE_LIMITS)('%s (%s) の上限 (%d バイト) を下回らない', (_name, _route, limit) => {
    // 入口の枠が経路の枠以上であることを確認する (下回ると本文が静かに切り詰められる)
    expect(ENTRY_MAX_BODY_BYTES).toBeGreaterThanOrEqual(limit);
  });

  it('この表が導出元の登録一覧と一致している (表の古びを検出する)', () => {
    // 表が導出元から取り残されると、新しい経路が上のケース群にも下の余白ケースにも現れず、
    // どちらも古い最大値のまま通ってしまう。表そのものの鮮度をここで固定する
    const listedNames = ROUTE_LIMITS.map(([name]) => name).sort();
    // 導出元の配列リテラルに実際に並んでいる定数名
    const registeredNames = registeredRouteLimitNames(
      readFileSync(ENTRY_MODULE_PATH, 'utf8'),
    ).sort();
    // 過不足なく一致していることを確認する
    expect(listedNames).toEqual(registeredNames);
  });

  it('最大の経路上限に対して、超過を観測できるだけの余白を残している', () => {
    // 経路別上限の最大値 (入口の枠はこれを基準に余白を足したものになる)
    const largestRouteLimit = Math.max(...ROUTE_LIMITS.map(([, , limit]) => limit));
    // 余白が消えると「入口の枠 ≧ 各経路の枠」は成立したままなのに、ルート側が上限超過を
    // 観測できなくなり 413 が返せなくなる (chunked 転送の超過が 400 に化ける)。
    // 経路ごとの比較では捕まえられない退行なので、余白そのものをここで固定する
    expect(ENTRY_MAX_BODY_BYTES - largestRouteLimit).toBeGreaterThanOrEqual(
      ENTRY_OVER_LIMIT_MARGIN_MIN_BYTES,
    );
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

  it('next.config.ts から辿るモジュールに `@/` エイリアスが混じっていない', () => {
    // 混じると `npm run build` だけが落ちる (typecheck もユニットテストも通ってしまう)。
    // 速い検査ですり抜ける退行なので、ここで押さえる
    expect(aliasImportsInEntryClosure()).toEqual([]);
  });

  it('上限つき読み取りの呼び出しが登録済みの定数だけを上限に使っている', () => {
    // 数値リテラルの直渡しや、export しないローカル定数を上限にすると、上の登録漏れ検出
    // (export された名前が手掛かり) に引っかからず、その経路だけ入口の枠が追随しないまま
    // 静かに切り詰められる。「使ってよいのは登録済みの名前だけ」の形にして両方を塞ぐ
    const registered = registeredRouteLimitNames(readFileSync(ENTRY_MODULE_PATH, 'utf8'));
    expect(boundedReadCallsWithUnregisteredLimit(sourceFiles(), registered)).toEqual([]);
  });
});
