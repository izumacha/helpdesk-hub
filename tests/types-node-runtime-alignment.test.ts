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
// 「実際に動く Node の major」の読み方 (ここが判定の土台):
//   ピン留めしている 3 か所 — `.nvmrc` / CI の `NODE_VERSION` / `Dockerfile` の
//   `FROM node:<major>` — は**同じ major を指していなければならない**。どれか 1 つを
//   上げ忘れると「どの Node に合わせるべきか」が決まらなくなり、判定基準そのものが崩れる。
//   一方 `package.json` の `engines.node` は `>=22.19.0` のような**下限**であって
//   ピンではない。等値で比べると、Node 24 へ上げたのに下限を 22 のまま残す
//   (最低サポート版の宣言としては妥当) だけで「食い違い」と報告してしまうので、
//   ここだけは **範囲としてピン留め版を許容するか** で見る。
//
// 何を防ぐか:
//   (a) 型と実行時のずれ … `@types/node` の major が、実際に動く Node の major と違う状態。
//       package.json の宣言とロックファイルの解決済み版の**両方**を見る
//       (宣言が正しくても、`overrides` や推移依存の巻き上げで解決版だけがずれうる)。
//   (b) 実行時 major 自体の食い違い・読み取り不能 … ピン 3 か所が別々の major を指す、
//       または書式が変わって読めない状態。読めなければ前提崩れとして落とす (fail-closed)。
//   (c) 保留の消失 … `@types/node` の major を止める ignore が消えた状態
//       (= 毎週 (a) を作る PR が立ち、緑なのでマージされてしまう)。
//   (d) 保留の効きすぎ … `update-types` が消える・`versions` のような別の絞り込みが足される・
//       同じパッケージのエントリが 2 件になるなどで、22 系の patch 更新まで届かなくなる状態。
//       Dependabot は update-types を書かない ignore を「全バージョンを無視」として扱い、
//       かつ複数のエントリを**すべて適用する**ため、行が 1 つ増減するだけで起きる。
//   (e) 保留の置き場所間違い … ignore が npm 以外のエコシステム (docker 等) や、
//       npm でも別ディレクトリのブロックの下に置かれた状態 (= (c) と同じ結末)。
//   (f) 保留の効く範囲の取り違え … `dependency-name` が `@types/*` のような
//       ワイルドカードへ書き換えられた状態。件数も update-types もキー集合も想定どおりの
//       ままなので (c)〜(e) では素通りするが、実際には `@types/react` など**他の
//       `@types/*` すべて**の major 追従まで止まる。名前そのものを完全一致で確かめる。
//
// 保留の外し方:
//   **この ignore は「永久に major を上げない」という意味ではない。** 動かす Node を
//   22 から次の LTS へ上げるときは、ピン 3 か所をまとめて上げれば判定基準が動くので、
//   同じ PR で `@types/node` も新しい major へ上げる。ignore は残したままでよい
//   (major 更新の主導権を Dependabot ではなく「ランタイムを上げる判断」に置くのが目的)。

// Vitest の DSL
import { describe, expect, it } from 'vitest';
// 設定ファイルを読むため (Node 標準の同期 API で十分)
import { readFileSync } from 'node:fs';
// engines.node は下限つきの**範囲**なので、等値ではなく範囲の重なりで見る (§9 自前実装しない)
import { intersects } from 'semver';
// dependabot.yml / ci.yml を構造として読むため (自前のテキスト解析にしない理由は
// dependabot-eslint-guard.test.ts の冒頭コメントを参照)
import { parse as parseYaml } from 'yaml';
// 読み方・パス・Dependabot の語彙は 2 本のガードで共有する (§6 DRY / 定数の一元管理)
import {
  ALLOWED_IGNORE_KEYS,
  asRecord,
  collectIgnoreEntries,
  DEPENDABOT_PATH,
  MAJOR_UPDATE_TYPE,
  NPM_DIRECTORY,
  NPM_ECOSYSTEM,
  PACKAGE_JSON_PATH,
  PACKAGE_LOCK_PATH,
  parseAllowedMajor,
  readDevDependencyRange,
  readLockedVersion,
  REPO_ROOT,
  sortedKeysOf,
  type DependabotConfig,
} from './lib/dependabot-config';
// 「実際に動く Node の major」をピン留めしている残り 2 か所
import { resolve } from 'node:path';

// ピン留めの出どころ (package.json は下限なので別扱い。冒頭コメント参照)
const NVMRC_PATH = resolve(REPO_ROOT, '.nvmrc');
const CI_WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/ci.yml');
const DOCKERFILE_PATH = resolve(REPO_ROOT, 'Dockerfile');

// ignore の対象パッケージ名 (dependabot.yml の dependency-name と完全一致させる)
const GUARDED_DEPENDENCY = '@types/node';

/** 「実際に動く Node の major」をピン留めしている出どころ 1 つ分。 */
interface PinnedSource {
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
 * `#` から行末までのコメントを落とした行の配列を返す。
 *
 * コメントを残したまま正規表現を当てると、`# NODE_VERSION: '20' へ上げる予定` のような
 * 解説行を設定値として読んでしまい、存在しない食い違いを報告する。
 */
function stripComments(text: string): string[] {
  // 行に分けたうえで、各行の `#` 以降を落とす
  return text.split('\n').map((line) => line.replace(/#.*$/, ''));
}

/**
 * `.nvmrc` に書かれた major を読み取る。
 *
 * major だけを書く運用だが、先頭の `v` とコメント行は許す。
 */
function readNvmrcMajor(): number | null {
  // ファイルを読む (読めなければ null)
  const text = readTextOrNull(NVMRC_PATH);
  if (text === null) return null;
  // コメントを落としたうえで、最初に数字が現れる行を探す
  for (const line of stripComments(text)) {
    const matched = line.trim().match(/^v?(\d+)/);
    if (matched) return Number(matched[1]);
  }
  // 数字が 1 つも無ければ読めなかった扱い
  return null;
}

/**
 * CI ワークフローの `env.NODE_VERSION` を読み取る。
 *
 * 正規表現ではなく YAML パーサで読むのは、解説コメントや別の場所に書かれた
 * `NODE_VERSION:` を設定値と取り違えないため (ESLint 側のガードと同じ理由)。
 */
function readCiNodeMajor(): number | null {
  // ワークフローを読む (読めなければ null)
  const text = readTextOrNull(CI_WORKFLOW_PATH);
  if (text === null) return null;
  // YAML として解釈し、env.NODE_VERSION を引く
  const value = asRecord(asRecord(parseYaml(text)).env).NODE_VERSION;
  // 文字列でも数値でも書けるので、いったん文字列にしてから major を取り出す
  const matched = String(value ?? '').match(/^(\d+)/);
  // 形が合わなければ読めなかった扱い
  return matched ? Number(matched[1]) : null;
}

/**
 * Dockerfile が使う Node のベースイメージ major を読み取る。
 *
 * **最初の 1 件だけを見ない。** 多段ビルドで `FROM node:20-alpine AS tools` のような
 * 別 major の段が足されると、先頭だけを見る実装では 22 のまま緑になり、
 * まさに検出したいドリフトを見逃す。すべての `FROM node:<major>` を集め、
 * 揃っていなければ「読めなかった」として呼び出し側で落とす。
 */
function readDockerfileNodeMajor(): number | null {
  // Dockerfile を読む (読めなければ null)
  const text = readTextOrNull(DOCKERFILE_PATH);
  if (text === null) return null;
  // コメントを落としたうえで、すべての `FROM node:<major>` を集める
  const majors = new Set<number>();
  for (const line of stripComments(text)) {
    const matched = line.match(/^\s*FROM\s+node:(\d+)/i);
    if (matched) majors.add(Number(matched[1]));
  }
  // ちょうど 1 つに揃っているときだけ採用する (0 件 = 読めない / 2 件以上 = 段ごとに食い違い)
  return majors.size === 1 ? [...majors][0] : null;
}

/**
 * 「実際に動く Node の major」をピン留めしている 3 か所を読み取って並べる。
 *
 * 1 か所だけを正としないのは、上げ忘れたときに**残りと食い違う**ことこそが
 * 検出したい状態だから。3 つすべてを返し、呼び出し側で「読めたか」「揃っているか」を見る。
 */
function collectPinnedSources(): PinnedSource[] {
  // 3 つの出どころをラベル付きで並べて返す
  return [
    { label: '.nvmrc', major: readNvmrcMajor() },
    { label: '.github/workflows/ci.yml (NODE_VERSION)', major: readCiNodeMajor() },
    { label: 'Dockerfile (FROM node:<major>)', major: readDockerfileNodeMajor() },
  ];
}

// 設定ファイル群とピン留めの読み取りは 1 度だけ行う (テストごとに読み直す必要はない)
const dependabotConfig = parseYaml(readFileSync(DEPENDABOT_PATH, 'utf8')) as DependabotConfig;
const packageJson: unknown = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8'));
const packageLock: unknown = JSON.parse(readFileSync(PACKAGE_LOCK_PATH, 'utf8'));
const pinnedSources = collectPinnedSources();
// 判定の基準になる実行時 major。ピンが揃っていない場合は null になり、
// それ自体を最初のテストが落とす (後続は「基準が無い」ことを明示して落ちる)
const runtimeMajor =
  new Set(pinnedSources.map((s) => s.major)).size === 1 ? pinnedSources[0].major : null;

// 対象パッケージに当たる ignore エントリ (件数・中身は個別のテストで確かめる)
const ignoreEntries = collectIgnoreEntries(
  dependabotConfig,
  NPM_ECOSYSTEM,
  NPM_DIRECTORY,
  GUARDED_DEPENDENCY,
);

describe('@types/node と実行時 Node の major 整合', () => {
  it('実行時 Node の major がピン留め 3 か所すべてから読み取れ、値も揃っている', () => {
    // 1 つでも読めなければ前提崩れ (fail-closed)。どこが読めなかったかを名指しする
    const unreadable = pinnedSources.filter((s) => s.major === null).map((s) => s.label);
    expect(
      unreadable,
      `実行時 Node の major を読み取れない出どころがある: ${unreadable.join(', ')}。` +
        'このテストは 3 か所の一致を前提にしているので、書式を変えた (多段ビルドで別 major を足した等) なら読み取りも合わせて直すこと。',
    ).toEqual([]);
    // 読み取れた major が全て同じであることを確かめる
    expect(
      [...new Set(pinnedSources.map((s) => s.major))],
      `実行時 Node の major が食い違っている: ${pinnedSources.map((s) => `${s.label}=${s.major}`).join(', ')}。` +
        'Node を上げるときは 3 か所すべてを同じ major に揃えること。',
    ).toHaveLength(1);
  });

  it('package.json の engines.node が、ピン留めした major の実行を許している', () => {
    // 基準が決まっていなければ、その事実を明示して落とす
    expect(
      runtimeMajor,
      'ピン留め 3 か所が揃っていないため、engines の判定基準が決まらない',
    ).not.toBeNull();
    // engines.node は下限つきの範囲なので、パース済みの package.json から素直に引く
    const enginesNode = asRecord(asRecord(packageJson).engines).node;
    // 文字列で書かれていなければ読めなかった扱いとして落とす
    expect(
      typeof enginesNode,
      `package.json の engines.node を文字列で書くこと。実際の値: ${String(enginesNode)}`,
    ).toBe('string');
    // 等値ではなく「その major 系列と範囲が重なるか」で見る。
    // 代表値 1 点 (`22.0.0` など) で試すと、`>=22.19.0` のように下限に minor/patch がある
    // 宣言を「Node 22 を許していない」と誤判定するため、系列そのもの (`22.x`) と重ねる
    expect(
      intersects(enginesNode as string, `${runtimeMajor}.x`),
      `engines.node (${String(enginesNode)}) がピン留めした Node ${runtimeMajor} の実行を許していない。` +
        '最低サポート版を下げたままにするのは妥当だが、ピンより上の下限を残すと動かない環境を宣言することになる。',
    ).toBe(true);
  });

  it('package.json の @types/node が、実行時 Node と同じ major を指している', () => {
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
    // ロックファイルから解決済みバージョンを取り出す (読み方は共有ヘルパー)
    const locked = readLockedVersion(packageLock, GUARDED_DEPENDENCY);
    // 見つからなければ前提崩れとして落とす
    expect(
      locked,
      `package-lock.json に ${GUARDED_DEPENDENCY} の解決済み版が見つからない`,
    ).not.toBeNull();
    // 実行時 major と一致していることを確かめる (宣言が正しくても解決だけずれる場合を捕まえる)
    expect(
      parseAllowedMajor(locked),
      `解決済みの ${GUARDED_DEPENDENCY} (${String(locked)}) の major が実行時 Node の major (${runtimeMajor}) と違う。`,
    ).toBe(runtimeMajor);
  });

  it('@types/node の major 更新を止める ignore が、npm の対象ディレクトリに 1 件だけある', () => {
    // 1 件だけであることを確かめる (0 件 = 保留の消失 / 2 件以上 = 効きすぎ)
    expect(
      ignoreEntries,
      `${GUARDED_DEPENDENCY} の ignore は ${NPM_ECOSYSTEM} / ${NPM_DIRECTORY} のブロックに 1 件だけ置くこと。` +
        'Dependabot は同じパッケージの複数エントリをすべて適用するため、2 件目が足されると効き方が変わる。',
    ).toHaveLength(1);
  });

  it('その ignore が @types/node だけを名指ししている (ワイルドカードで他の @types/* を巻き込まない)', () => {
    // 件数・update-types・キー集合が想定どおりでも、名前が `@types/*` へ書き換えられると
    // 他の `@types/*` すべての major 追従まで止まる。名前そのものを完全一致で確かめる
    expect(
      ignoreEntries[0]?.['dependency-name'],
      `ignore の dependency-name は ${GUARDED_DEPENDENCY} と完全一致で書くこと。` +
        '`@types/*` のようなワイルドカードにすると @types/react など他の型定義まで major が止まり、' +
        'しかも件数・update-types・キー集合はすべて想定どおりのまま素通りする。',
    ).toBe(GUARDED_DEPENDENCY);
  });

  it('その ignore が major 更新だけを止めている (patch/minor は届く)', () => {
    // 想定外のキー (versions など) が増えていないことを確かめる
    expect(
      sortedKeysOf(ignoreEntries[0]),
      'ignore エントリに想定外のキーがある。versions などを足すと 22 系の patch 更新まで止まる。',
    ).toEqual([...ALLOWED_IGNORE_KEYS].sort());
    // update-types が「major だけ」であることを確かめる
    expect(
      ignoreEntries[0]?.['update-types'],
      'update-types が major 限定でなくなっている。空にすると全バージョンが無視される。',
    ).toEqual([MAJOR_UPDATE_TYPE]);
  });
});
