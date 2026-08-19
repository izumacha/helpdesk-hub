// Dockerfile が明示的にコピーする seed 用ソースの一覧が、実際に必要な集合と一致することを
// 固定するテスト。
//
// なぜテストで縛るのか:
//   `docker compose exec app npx prisma db seed` (README / CLAUDE.md §2 の手順) が動くには、
//   seed が import する `src/` 配下のファイルが実行イメージに要る。Dockerfile はそれを
//   1 ファイルずつ列挙しているが、その一覧は人手の約束にすぎない。`prisma/seed.ts` が
//   モジュールをもう 1 つ import した日に列挙から漏れ、**本番のコンテナで seed を叩いた
//   ときだけ** `Cannot find module` で落ちる。CI はイメージをビルドしないので、この壊れ方は
//   マージ後まで表面化しない。
//
// **注意 (誤解しやすい点)**: これは「実行イメージへの露出を絞る」検査ではない。
//   Dockerfile が先に `COPY /app/.next/standalone ./` しており、Next のファイルトレースの
//   副作用で standalone にはリポジトリのソースがほぼそのまま入る (実測で src/ 全体・
//   tests/・docs/ まで含まれる)。つまり実行イメージにはどのみちソースが載っている。
//   ここで固定したいのは「seed が確実に動く最小集合が明示され、かつ膨らんでいないこと」。
//
// 何を防ぐか:
//   (a) seed の import が増えたのに Dockerfile の COPY を足し忘れた状態 (イメージが壊れる)。
//   (b) 逆に、seed が使わないファイルやディレクトリを列挙へ足した状態
//       (`src/lib` を丸ごと書く変更もここで落ちる。何が必要かの記録として一覧を保つため)。
//
// **ソースの走査は TypeScript のパーサで行う** (`tests/entry-body-limit.test.ts` と同じ理由:
// 正規表現だと文字列リテラル中の import らしき文字列を拾う / 実際の import を取り落とす、
// どちらの間違いも「検査が黙って緩む」方向に効いてしまうため)。

// Vitest の DSL
import { describe, expect, it } from 'vitest';
// Dockerfile を読むため (Node 標準の同期 API で十分)
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
// ソースの構文木と import 解決は検出網どうしで共有する (tests/entry-body-limit.test.ts と同じ土台)
import {
  collectModuleSpecifiers,
  parseSourceFile,
  resolveModuleSpecifier,
} from './lib/source-module-graph';

// リポジトリのルート (このテストファイルは tests/ 直下にある)
const REPO_ROOT = resolve(__dirname, '..');
// 走査の起点。`prisma db seed` が実行するスクリプト (コマンド定義は prisma.config.ts)
const SEED_ENTRY = join(REPO_ROOT, 'prisma/seed.ts');
// 実行イメージへ手で選んで入れる対象のディレクトリ (この配下だけを「過不足」の検査対象にする)
const HAND_PICKED_DIR = 'src/lib';
// `src/` の絶対パス (import 解決の起点として共有ヘルパーへ渡す)
const SRC_DIR = join(REPO_ROOT, 'src');

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
    for (const specifier of collectModuleSpecifiers(parseSourceFile(current))) {
      const resolved = resolveModuleSpecifier(specifier, current, SRC_DIR);
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

  it(`明示的にコピーする ${HAND_PICKED_DIR} 配下は seed が実際に使うファイルだけ`, () => {
    // src/lib 配下に届きうるコピー指定を集める。自分が src/lib の下にある場合 (src/lib/xxx) と、
    // 自分が src/lib を含む上位ディレクトリの場合 (src/lib, src) の両方を対象にする
    // — 後者を見ないと「src/lib を丸ごと」「src を丸ごと」に戻す変更を取り逃がす
    const reachingLib = copiedPaths.filter(
      (path) =>
        path === HAND_PICKED_DIR ||
        path.startsWith(`${HAND_PICKED_DIR}/`) ||
        HAND_PICKED_DIR.startsWith(`${path}/`),
    );
    // それぞれが「seed が実際に import しているファイルそのもの」でなければ余計な公開になる
    // (ディレクトリ指定はこの条件を満たせないので、丸ごとコピーはここで落ちる)
    const overExposed = reachingLib.filter((path) => !requiredFiles.has(path));
    // 1 つも無いことを求める
    expect(overExposed).toEqual([]);
  });
});
