// `@types/node` の major を、このアプリが**実際に動く Node.js の major** に固定するテスト。
//
// なぜテストで縛るのか:
//   `@types/node` は DefinitelyTyped の慣習として **major が Node 本体のリリース系列に対応**
//   する。つまり `@types/node@26` は「Node 26 の API 一覧」であり、Node 22 で動くコードの
//   型チェックに使うものではない。にもかかわらず、ここがずれても **lint も型チェックも
//   通ってしまう** — むしろ「型が API の存在を主張する」ぶん、
//   Node 22 に存在しない API を書いても `tsc --noEmit` が緑のまま通る。
//   壊れるのは本番の実行時で、`TypeError: x is not a function` になって初めて分かる。
//   これは ESLint の保留 (`tests/dependabot-eslint-guard.test.ts`) と同じ **fail-open** で、
//   しかも「CI が緑だから安全」という判断そのものを裏切る点でより質が悪い。
//
//   実際 Dependabot は `@types/node` を 22 系から 26 系へ上げる PR (#310) を立てており、
//   4 つのジョブすべてが緑だった。**緑なのは型が広がったからであって、動くからではない。**
//
// 何を防ぐか:
//   (a) 型と実行時のずれ … `@types/node` の major が、実際に動く Node の major と違う状態。
//       package.json の宣言とロックファイルの解決済み版の**両方**を見る
//       (宣言が正しくても、`overrides` や推移依存の巻き上げで解決版だけがずれうる)。
//   (b) 実行時 major 自体の食い違い … `.nvmrc` / CI の `NODE_VERSION` / Dockerfile の
//       ベースイメージ / `engines.node` が別々の major を指す状態。どれか 1 つを上げ忘れると
//       「どの Node に合わせるべきか」が決まらなくなり、(a) の判定基準そのものが崩れる。
//       4 つすべてを読み、1 つでも読めなければ前提崩れとして落とす (fail-closed)。
//   (c) 保留の消失 … `@types/node` の major を止める ignore が消えた状態
//       (= 毎週 (a) を作る PR が立ち、緑なのでマージされてしまう)。
//   (d) 保留の効きすぎ … `update-types` が消える・`versions` のような別の絞り込みが足される・
//       同じパッケージのエントリが 2 件になるなどで、22 系の patch 更新まで届かなくなる状態。
//       Dependabot は update-types を書かない ignore を「全バージョンを無視」として扱い、
//       かつ複数のエントリを**すべて適用する**ため、行が 1 つ増減するだけで起きる。
//   (e) 保留の置き場所間違い … ignore が npm 以外のエコシステム (docker 等) や、
//       npm でも別ディレクトリのブロックの下に置かれた状態 (= (c) と同じ結末)。
//
// 保留の外し方:
//   **この ignore は「永久に major を上げない」という意味ではない。** 動かす Node を
//   22 から次の LTS へ上げるときは、(b) の 4 か所をまとめて上げれば (a) の判定基準が動くので、
//   同じ PR で `@types/node` も新しい major へ上げる。ignore は残したままでよい
//   (major 更新の主導権を Dependabot ではなく「ランタイムを上げる判断」に置くのが目的)。

// Vitest の DSL
import { describe, expect, it } from 'vitest';
// 設定ファイルを読むため (Node 標準の同期 API で十分)
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// dependabot.yml を構造として読むため (自前のテキスト解析にしない理由は
// dependabot-eslint-guard.test.ts の冒頭コメントを参照)
import { parse as parseYaml } from 'yaml';
// dependabot.yml の読み方は 2 本のテストで共有する (§6 DRY)
import {
  collectIgnoreEntries,
  parseAllowedMajor,
  readDevDependencyRange,
  sortedKeysOf,
  type DependabotConfig,
} from './lib/dependabot-config';

// リポジトリのルート (このテストファイルは tests/ 直下にある)
const REPO_ROOT = resolve(__dirname, '..');
// 検査対象: Dependabot の設定・依存の宣言・依存の解決済み版
const DEPENDABOT_PATH = resolve(REPO_ROOT, '.github/dependabot.yml');
const PACKAGE_JSON_PATH = resolve(REPO_ROOT, 'package.json');
const PACKAGE_LOCK_PATH = resolve(REPO_ROOT, 'package-lock.json');
// 「実際に動く Node の major」を宣言している 4 か所
const NVMRC_PATH = resolve(REPO_ROOT, '.nvmrc');
const CI_WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/ci.yml');
const DOCKERFILE_PATH = resolve(REPO_ROOT, 'Dockerfile');

// ignore の対象パッケージ名 (dependabot.yml の dependency-name と一致させる)
const GUARDED_DEPENDENCY = '@types/node';
// 保留を書いているエコシステム。ここ以外に置いても npm には効かない
const GUARDED_ECOSYSTEM = 'npm';
// 保留を書いている対象ディレクトリ。npm のブロックが複数ある構成 (モノレポ等) で、
// 別ディレクトリのブロックに書かれた ignore を「効いている」と読み違えないために見る
const GUARDED_DIRECTORY = '/';
// major 更新だけを止めるための update-types 値 (Dependabot の予約語)
const MAJOR_UPDATE_TYPE = 'version-update:semver-major';
// ignore エントリに書いてよいキーの一覧 (これ以外が増えると効き方が変わる)
const ALLOWED_IGNORE_KEYS = ['dependency-name', 'update-types'];

/** 「実際に動く Node の major」の出どころ 1 つ分。 */
interface RuntimeSource {
  // 失敗メッセージに出す、人が読める出どころの名前
  label: string;
  // 読み取れた major (読めなければ null)
  major: number | null;
}

/**
 * ファイルを文字列として読む。存在しなければ null を返す。
 *
 * 読めないこと自体を「前提崩れ」として呼び出し側で落とすため、ここでは例外にしない。
 */
function readTextOrNull(path: string): string | null {
  try {
    // UTF-8 のテキストとして読み込む
    return readFileSync(path, 'utf8');
  } catch {
    // 存在しない・読めない場合は null を返し、呼び出し側の存在確認で落とす
    return null;
  }
}

/**
 * 正規表現の 1 つ目の捕捉グループを数値 major として取り出す。
 *
 * 読めない場合は null を返す。ここで「たぶん 22 だろう」と補うと、
 * 出どころが 1 つ壊れただけで検査全体が意味を失うため、必ず呼び出し側で落とす。
 */
function matchMajor(text: string | null, pattern: RegExp): number | null {
  // ファイルが読めていなければ判定のしようがない
  if (text === null) return null;
  // パターンに当てて 1 つ目の捕捉グループを取り出す
  const matched = text.match(pattern);
  // 当たらなければ「読めなかった」ことを伝える
  if (!matched) return null;
  // 取り出した major を数値にして返す
  return Number(matched[1]);
}

/**
 * 「実際に動く Node の major」を宣言している 4 か所を読み取って並べる。
 *
 * 1 か所だけを正としないのは、上げ忘れたときに**残りの 3 か所と食い違う**ことこそが
 * 検出したい状態だから。4 つすべてを返し、呼び出し側で「読めたか」「揃っているか」を見る。
 */
function collectRuntimeSources(): RuntimeSource[] {
  // .nvmrc は major だけを書く運用 (先頭の v は付いていても許す)
  const nvmrc = matchMajor(readTextOrNull(NVMRC_PATH), /^\s*v?(\d+)/);
  // CI は env の NODE_VERSION に major を文字列で持つ (例: NODE_VERSION: '22')
  const ci = matchMajor(readTextOrNull(CI_WORKFLOW_PATH), /NODE_VERSION:\s*['"]?(\d+)/);
  // Dockerfile のベースイメージ (例: FROM node:22-alpine AS base)
  const docker = matchMajor(readTextOrNull(DOCKERFILE_PATH), /FROM\s+node:(\d+)/);
  // package.json の engines.node (例: ">=22.19.0")
  const packageJson = readTextOrNull(PACKAGE_JSON_PATH);
  // engines.node は範囲式なので、下限の major を取り出す
  const engines = matchMajor(packageJson, /"node"\s*:\s*"[^"\d]*(\d+)/);
  // 4 つの出どころをラベル付きで並べて返す
  return [
    { label: '.nvmrc', major: nvmrc },
    { label: '.github/workflows/ci.yml (NODE_VERSION)', major: ci },
    { label: 'Dockerfile (FROM node:<major>)', major: docker },
    { label: 'package.json (engines.node)', major: engines },
  ];
}

/**
 * ロックファイルから、巻き上げられた `@types/node` の解決済みバージョンを取り出す。
 *
 * package.json の宣言が正しくても、`overrides` や推移依存の巻き上げで
 * 実際に使われる版だけがずれることがあるため、解決結果も併せて見る。
 */
function readLockedVersion(lock: unknown, name: string): string | null {
  // トップレベルがオブジェクトでなければ読み進めない
  if (typeof lock !== 'object' || lock === null) return null;
  // packages の枝 (パッケージのパス → メタデータ) を取り出す
  const packages = (lock as { packages?: unknown }).packages;
  // それ自体がオブジェクトでなければ、やはり読み進めない
  if (typeof packages !== 'object' || packages === null) return null;
  // 巻き上げ位置のメタデータを引く
  const meta = (packages as Record<string, unknown>)[`node_modules/${name}`];
  // オブジェクトでなければ見つからなかった扱い
  if (typeof meta !== 'object' || meta === null) return null;
  // version を取り出す (文字列でなければ見つからなかった扱い)
  const version = (meta as { version?: unknown }).version;
  return typeof version === 'string' ? version : null;
}

// 設定ファイル群を 1 度だけ読み込む (テストごとに読み直す必要はない)
const dependabotConfig = parseYaml(readFileSync(DEPENDABOT_PATH, 'utf8')) as DependabotConfig;
const packageJson: unknown = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8'));
const packageLock: unknown = JSON.parse(readFileSync(PACKAGE_LOCK_PATH, 'utf8'));

describe('@types/node と実行時 Node の major 整合', () => {
  it('実行時 Node の major が 4 か所すべてから読み取れ、値も揃っている', () => {
    // 4 つの出どころを読み取る
    const sources = collectRuntimeSources();
    // 1 つでも読めなければ前提崩れ (fail-closed)。どこが読めなかったかを名指しする
    const unreadable = sources.filter((s) => s.major === null).map((s) => s.label);
    expect(
      unreadable,
      `実行時 Node の major を読み取れない出どころがある: ${unreadable.join(', ')}。` +
        'このテストは 4 か所の一致を前提にしているので、書式を変えたならここの読み取りも合わせて直すこと。',
    ).toEqual([]);
    // 読み取れた major が全て同じであることを確かめる
    const majors = [...new Set(sources.map((s) => s.major))];
    expect(
      majors,
      `実行時 Node の major が食い違っている: ${sources.map((s) => `${s.label}=${s.major}`).join(', ')}。` +
        'Node を上げるときは 4 か所すべてを同じ major に揃えること。',
    ).toHaveLength(1);
  });

  it('package.json の @types/node が、実行時 Node と同じ major を指している', () => {
    // 判定の基準になる実行時 major (前のテストで一致が保証されている)
    const runtimeMajor = collectRuntimeSources()[0].major;
    // package.json の devDependencies から宣言された範囲を取り出す
    const declared = readDevDependencyRange(packageJson, GUARDED_DEPENDENCY);
    // 範囲から許容 major を読み取る
    const declaredMajor = parseAllowedMajor(declared);
    // 読めない書き方なら落とす (読めない範囲を「たぶん合っている」と決めつけない)
    expect(
      declaredMajor,
      `package.json の ${GUARDED_DEPENDENCY} を、このテストが解釈できる形 (^22.19.17 など) で書くこと。実際の値: ${String(declared)}`,
    ).not.toBeNull();
    // 実行時 major と一致していることを確かめる
    expect(
      declaredMajor,
      `${GUARDED_DEPENDENCY} の major (${declaredMajor}) が実行時 Node の major (${runtimeMajor}) と違う。` +
        '型だけが先に進むと、実行時に存在しない API を書いても tsc が通ってしまう (本番でのみ壊れる)。',
    ).toBe(runtimeMajor);
  });

  it('ロックファイルの解決済み @types/node も、実行時 Node と同じ major になっている', () => {
    // 判定の基準になる実行時 major
    const runtimeMajor = collectRuntimeSources()[0].major;
    // ロックファイルから解決済みバージョンを取り出す
    const locked = readLockedVersion(packageLock, GUARDED_DEPENDENCY);
    // 見つからなければ前提崩れとして落とす
    expect(
      locked,
      `package-lock.json に ${GUARDED_DEPENDENCY} の解決済み版が見つからない`,
    ).not.toBeNull();
    // 解決済みバージョンの major を取り出す
    const lockedMajor = parseAllowedMajor(locked);
    // 実行時 major と一致していることを確かめる (宣言が正しくても解決だけずれる場合を捕まえる)
    expect(
      lockedMajor,
      `解決済みの ${GUARDED_DEPENDENCY} (${String(locked)}) の major が実行時 Node の major (${runtimeMajor}) と違う。`,
    ).toBe(runtimeMajor);
  });

  it('@types/node の major 更新を止める ignore が、npm の対象ディレクトリに 1 件だけある', () => {
    // 対象パッケージに当たる ignore エントリをすべて集める
    const entries = collectIgnoreEntries(
      dependabotConfig,
      GUARDED_ECOSYSTEM,
      GUARDED_DIRECTORY,
      GUARDED_DEPENDENCY,
    );
    // 1 件だけであることを確かめる (0 件 = 保留の消失 / 2 件以上 = 効きすぎ)
    expect(
      entries,
      `${GUARDED_DEPENDENCY} の ignore は ${GUARDED_ECOSYSTEM} / ${GUARDED_DIRECTORY} のブロックに 1 件だけ置くこと。` +
        'Dependabot は同じパッケージの複数エントリをすべて適用するため、2 件目が足されると効き方が変わる。',
    ).toHaveLength(1);
  });

  it('その ignore が major 更新だけを止めている (patch/minor は届く)', () => {
    // 対象の ignore エントリを取り出す (前のテストで 1 件であることが保証されている)
    const [entry] = collectIgnoreEntries(
      dependabotConfig,
      GUARDED_ECOSYSTEM,
      GUARDED_DIRECTORY,
      GUARDED_DEPENDENCY,
    );
    // 想定外のキー (versions など) が増えていないことを確かめる
    expect(
      sortedKeysOf(entry),
      'ignore エントリに想定外のキーがある。versions などを足すと 22 系の patch 更新まで止まる。',
    ).toEqual([...ALLOWED_IGNORE_KEYS].sort());
    // update-types が「major だけ」であることを確かめる
    expect(
      entry['update-types'],
      'update-types が major 限定でなくなっている。空にすると全バージョンが無視される。',
    ).toEqual([MAJOR_UPDATE_TYPE]);
  });
});
