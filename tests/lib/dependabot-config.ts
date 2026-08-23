// 検査対象のパスを組み立てるため
import { resolve } from 'node:path';

// `.github/dependabot.yml` を「構造として」読むための共有ヘルパー。
//
// なぜ切り出すのか:
//   Dependabot の ignore を見張るテストは 1 本ではなくなった
//   (`tests/dependabot-eslint-guard.test.ts` と
//    `tests/types-node-runtime-alignment.test.ts`)。どちらも
//   「npm・対象ディレクトリのブロックを選ぶ → その ignore から対象パッケージの
//    エントリを**すべて**集める」という同じ読み方をする。書き写すと、
//   Dependabot の仕様に合わせた細かい配慮 (`directories` の複数形・glob、
//   `dependency-name` のワイルドカード、複数エントリがすべて適用されること) が
//   片方だけ直されて、もう片方の検出網が静かに緩む。読み方の定義はここ 1 か所に置く
//   (CLAUDE.md §6 DRY)。
//
// ここに置くのは「設定をどう読むか」だけで、「何を良しとするか」は各テストが持つ。

/** dependabot.yml の ignore エントリのうち、この検査が読む部分だけを表す型。 */
export interface DependabotIgnoreEntry {
  'dependency-name'?: unknown;
  'update-types'?: unknown;
}

/** dependabot.yml の updates 1 ブロックのうち、この検査が読む部分だけを表す型。 */
export interface DependabotUpdateEntry {
  'package-ecosystem'?: unknown;
  // Dependabot は単数形の `directory` と複数形の `directories`(配列) の両方を受け付ける
  directory?: unknown;
  directories?: unknown;
  ignore?: unknown;
}

/** dependabot.yml のトップレベルのうち、この検査が読む部分だけを表す型。 */
export interface DependabotConfig {
  updates?: unknown;
}

/**
 * 配列でなければ空配列にして返す。
 *
 * YAML は何でも書けるので、想定した形でなければ「空」として扱い、
 * 呼び出し側の検査 (エントリが存在すること) を落とす方向へ倒す。
 */
function asArray(value: unknown): unknown[] {
  // 配列ならそのまま、そうでなければ空配列 (= 見つからなかった扱い)
  return Array.isArray(value) ? value : [];
}

/**
 * オブジェクトなら Record として、そうでなければ空オブジェクトとして返す小さな補助。
 */
export function asRecord(value: unknown): Record<string, unknown> {
  // オブジェクト以外は「キーが無い」ものとして扱う
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * ignore エントリの `dependency-name` が、対象パッケージに当たるかを判定する。
 *
 * Dependabot の `dependency-name` は `*` をワイルドカードとして解釈するため、
 * 文字列の完全一致だけで見ると `"*"` や `"eslint*"` のエントリを取り落とす。
 * それらも対象パッケージに効いてしまう (しかも update-types 無しなら全バージョンを止める) ので、
 * ワイルドカードを展開して照合する。
 *
 * パターンはこのリポジトリ自身の設定ファイル由来なので、外部入力を正規表現に
 * 通すときの懸念 (§9 の ReDoS) は当たらない。それでも `*` 以外のメタ文字は
 * エスケープして、意図しないパターンとして解釈されないようにする。
 */
function ignoreNameMatches(pattern: unknown, dependencyName: string): boolean {
  // 文字列でなければ照合のしようがない (= 当たらない扱い)
  if (typeof pattern !== 'string') return false;
  // `*` 以外の正規表現メタ文字を無効化してから、`*` だけを「任意の文字列」に置き換える
  const source = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  // 前後を固定して全体一致で判定する
  return new RegExp(`^${source}$`).test(dependencyName);
}

/**
 * `directories` に書ける 1 つのパターンが、対象ディレクトリを覆うかを判定する。
 *
 * Dependabot の `directories` は完全一致のほか `*` / `**` の glob を受け付ける。
 * ここで扱うのは自分たちが書いた設定の 1 要素だけなので、`*` を「`/` を含まない任意」、
 * `**` を「任意」として素直に展開すれば足りる。
 */
function directoryPatternCovers(pattern: string, directory: string): boolean {
  // `**` は「任意」、`*` は「/ を含まない任意」に相当する。先に `**` を目印へ退避し、
  // 残った正規表現メタ文字を無効化してから、目印を展開し直す
  const doubleStarMark = '\u0000';
  const escaped = pattern
    .replace(/\*\*/g, doubleStarMark)
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .split(doubleStarMark)
    .join('.*');
  // 前後を固定して全体一致で判定する
  return new RegExp(`^${escaped}$`).test(directory);
}

/**
 * update ブロックが、対象ディレクトリを担当しているかを判定する。
 *
 * Dependabot は単数形の `directory: "/"` と複数形の `directories: ["/"]` の両方を
 * 受け付ける。単数形だけを見ていると、複数形へ書き換えられた瞬間に「ブロックが無い」と
 * 読み違え、実際には効いている ignore を「消えた」と報告してしまう
 * (その指摘に従って 2 件目を足すと、今度は Dependabot が両方を適用して効きすぎる)。
 */
function coversDirectory(entry: DependabotUpdateEntry, directory: string): boolean {
  // 単数形が一致すればそれで確定
  if (entry.directory === directory) return true;
  // 複数形は glob も書ける (`["/**"]` / `["/*"]`)。完全一致だけを見ると、
  // 実際には担当しているブロックを「無い」と読み違えるので、glob も展開して照合する
  return asArray(entry.directories).some(
    (value) => typeof value === 'string' && directoryPatternCovers(value, directory),
  );
}

/**
 * 指定したエコシステムの ignore から、対象パッケージのエントリを**すべて**集める。
 *
 * 1 件目だけを取らないのは、Dependabot が同じパッケージに対する複数のエントリを
 * **すべて適用する**ため。`- dependency-name: "eslint"` だけのエントリ (update-types 無し =
 * 全バージョンを無視) が 2 件目に足されると、1 件目だけ見ていては「major だけ止めている」
 * と誤読したまま、実際には 9 系の更新も止まっている状態を見逃す。
 *
 * エコシステム違い・パッケージ名違いはすべて「見つからない」に落ちるので、
 * 置き場所を間違えた ignore を有効なものと取り違えることもない。
 */
export function collectIgnoreEntries(
  config: DependabotConfig,
  ecosystem: string,
  directory: string,
  dependencyName: string,
): DependabotIgnoreEntry[] {
  // updates 直下から「エコシステムとディレクトリの両方が一致する」ブロックを集める。
  // エコシステムだけで最初の 1 件を採ると、npm のブロックが複数ある構成 (モノレポ等) で
  // 別ディレクトリのブロックに書かれた ignore を、このプロジェクトに効いていると読み違える
  const blocks = asArray(config.updates)
    .map((entry) => entry as DependabotUpdateEntry)
    .filter(
      (entry) => entry['package-ecosystem'] === ecosystem && coversDirectory(entry, directory),
    );
  // 該当ブロックの ignore から対象パッケージに当たるエントリをすべて集めて返す
  // (完全一致だけでなく `*` / `eslint*` のようなワイルドカードも拾う)
  return blocks.flatMap((block) =>
    asArray(block.ignore)
      .map((entry) => entry as DependabotIgnoreEntry)
      .filter((entry) => ignoreNameMatches(entry['dependency-name'], dependencyName)),
  );
}

/**
 * ignore エントリに書かれているキーを並べ替えて返す。
 *
 * 想定外のキー (`versions` など) が増えていないかを比較するために使う。
 * オブジェクトでなければ空配列を返し、呼び出し側の比較を落とす方向へ倒す。
 */
export function sortedKeysOf(entry: DependabotIgnoreEntry): string[] {
  // オブジェクトでなければキーを数えようがない
  if (typeof entry !== 'object' || entry === null) return [];
  // キーを取り出して並べ替える (比較しやすくするため)
  return Object.keys(entry).sort();
}

/**
 * `'^9.39.4'` のようなバージョン範囲から、許容される最小の major を取り出す。
 *
 * ここで扱うのは自分たちが書いた package.json の 1 エントリだけなので、`^` / `~` / 素の数値
 * という実際に使っている形しか解釈しない。文字列でない値 (キーごと消えて undefined など) や
 * 判定できない書き方 (`>=9 <11` のような複合範囲) は null を返し、呼び出し側で「読めなかった」
 * として落とす — 読めない範囲を勝手に「9 系だろう」と決めつけると、10 系へ上げた日に
 * 検査が黙って素通りしてしまう。
 */
export function parseAllowedMajor(range: unknown): number | null {
  // 文字列でなければ解釈のしようがない (返り値の契約どおり null を返し、例外は投げない)
  if (typeof range !== 'string') return null;
  // 先頭のレンジ記号 (^ または ~) を 1 つだけ許し、そのあとに major の数字が続く形に限定する
  const matched = range.trim().match(/^[\^~]?(\d+)(?:\.\d+)*$/);
  // 形が合わなければ「読めなかった」ことを呼び出し側へ伝える
  if (!matched) return null;
  // 取り出した major を数値にして返す
  return Number(matched[1]);
}

/**
 * package.json の devDependencies から、指定パッケージのバージョン範囲を取り出す。
 *
 * `JSON.parse` の戻り値は `any` になるため (CLAUDE.md §6 で禁止)、`unknown` で受けてから
 * 必要な枝だけを型で絞る。途中の形が想定と違えば undefined を返し、呼び出し側の
 * 「解釈できる形か」検査で落ちる。
 */
export function readDevDependencyRange(json: unknown, dependencyName: string): unknown {
  // トップレベルがオブジェクトでなければ読み進めない
  if (typeof json !== 'object' || json === null) return undefined;
  // devDependencies の枝を取り出す
  const devDependencies = (json as { devDependencies?: unknown }).devDependencies;
  // それ自体がオブジェクトでなければ、やはり読み進めない
  if (typeof devDependencies !== 'object' || devDependencies === null) return undefined;
  // 目的のパッケージのバージョン範囲を返す (無ければ undefined)
  return (devDependencies as Record<string, unknown>)[dependencyName];
}

// ここから下は「どこを読むか」と Dependabot の語彙。2 本のガードが同じ値を別々に
// 書き写していると、npm ブロックの directory を変えた・Dependabot が update-types の
// 語彙を変えたときに片方だけ直され、もう片方は古いリテラルに対して緑を報告し続ける
// (CLAUDE.md §6 定数の一元管理)

// リポジトリのルート (このファイルは tests/lib/ にある)
export const REPO_ROOT = resolve(__dirname, '../..');
// Dependabot の設定ファイル
export const DEPENDABOT_PATH = resolve(REPO_ROOT, '.github/dependabot.yml');
// 依存の宣言
export const PACKAGE_JSON_PATH = resolve(REPO_ROOT, 'package.json');
// 依存の解決済み版 (package.json には現れない推移依存もここに出る)
export const PACKAGE_LOCK_PATH = resolve(REPO_ROOT, 'package-lock.json');
// 保留を書くエコシステム。ここ以外に置いても npm には効かない
export const NPM_ECOSYSTEM = 'npm';
// 保留を書く対象ディレクトリ。npm のブロックが複数ある構成で読み違えないために見る
export const NPM_DIRECTORY = '/';
// major 更新だけを止めるための update-types 値 (Dependabot の予約語)
export const MAJOR_UPDATE_TYPE = 'version-update:semver-major';
// ignore エントリに書いてよいキーの一覧 (これ以外が増えると効き方が変わる)
export const ALLOWED_IGNORE_KEYS = ['dependency-name', 'update-types'];

/**
 * npm のロックファイルから `packages` の枝 (パッケージのパス → メタデータ) を取り出す。
 *
 * トップレベルや `packages` がオブジェクトでなければ空として返し、
 * 呼び出し側の「見つかったか」検査で落ちる方向へ倒す。
 */
export function lockPackages(lock: unknown): Record<string, unknown> {
  // トップレベルがオブジェクトでなければ読み進めない
  return asRecord(asRecord(lock).packages);
}

/**
 * ロックファイルから、巻き上げ (hoist) された位置にあるパッケージの解決済み版を取り出す。
 *
 * package.json の宣言が正しくても、`overrides` や推移依存の巻き上げで
 * 実際に使われる版だけがずれることがあるため、宣言とは別に解決結果も見る用途。
 */
export function readLockedVersion(lock: unknown, name: string): string | null {
  // 巻き上げ位置のメタデータを引く
  const meta = asRecord(lockPackages(lock)[`node_modules/${name}`]);
  // version を取り出す (文字列でなければ見つからなかった扱い)
  return typeof meta.version === 'string' ? meta.version : null;
}
