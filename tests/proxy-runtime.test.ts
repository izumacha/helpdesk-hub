// リクエスト入口 (認証ガード) が Node.js ランタイムで動き続けることを機械的に固定するテスト。
//
// なぜテストで縛るのか (issue #298):
//   `src/lib/auth.ts` の `jwt` コールバックは、ロールの定期リフレッシュ (30 分間隔) と
//   旧 JWT の tenantId 補完で Prisma を呼ぶ。この Prisma クライアントはネイティブ engine の
//   ため Edge ランタイムでは動かず、Edge だった頃は「セッションが 30 分を超えた瞬間に
//   `JWTSessionError` になり、ログイン中のユーザーが /login に弾き返される」不具合があった。
//   ログイン直後の 30 分間は DB を引かないため **E2E でも表面化しない**種類の不具合で、
//   実際 #298 以前は全 E2E が緑のまま見逃されていた。だからこそ、振る舞いのテストではなく
//   「入口がどのファイル規約に乗っているか」を直接固定する。
//
// 何を防ぐか:
//   Next.js は `src/middleware.ts` と `src/proxy.ts` が**両方**あればビルドエラーにするが、
//   `src/proxy.ts` を消して `src/middleware.ts` だけを置いた場合はビルドが通り、入口が黙って
//   Edge ランタイムへ戻る (古いブランチのマージ・codemod の巻き戻し・チュートリアル流用など)。
//   その「静かな退行」をここで落とす。

// Vitest の DSL
import { describe, expect, it } from 'vitest';
// ファイルの存在確認と読み取り (Node 標準の同期 API で十分)
import { existsSync, readFileSync } from 'node:fs';
// リポジトリルートからの絶対パスを組み立てるため
import { join } from 'node:path';

// リポジトリのルート (このテストファイルは <root>/tests/ にあるので 1 つ上)
const REPO_ROOT = join(__dirname, '..');
// 現行のリクエスト入口 (Next.js 16 の proxy file convention)
const PROXY_PATH = join(REPO_ROOT, 'src', 'proxy.ts');
// 旧規約のファイル。存在してはいけない
const LEGACY_MIDDLEWARE_PATH = join(REPO_ROOT, 'src', 'middleware.ts');

describe('リクエスト入口のランタイム前提 (issue #298)', () => {
  it('src/proxy.ts が存在する (これが唯一の入口)', () => {
    // proxy 規約のファイルがあることを確認する
    expect(existsSync(PROXY_PATH)).toBe(true);
  });

  it('src/middleware.ts は存在しない (存在すると入口が Edge ランタイムへ戻る)', () => {
    // 旧規約のファイルが復活していないことを確認する
    expect(existsSync(LEGACY_MIDDLEWARE_PATH)).toBe(false);
  });

  it('src/proxy.ts は規約どおり `proxy` という名前でエクスポートする', () => {
    // 入口ファイルの中身を文字列として読み込む
    const source = readFileSync(PROXY_PATH, 'utf8');
    // Next.js のエントリテンプレートは `mod.proxy || mod.default` の順に解決する。
    // default export でも動くが、規約名で公開されていることをここで固定する。
    // `m` フラグ + 行頭アンカーで、解説コメント中の同じ字面に反応しないようにする
    expect(source).toMatch(/^export\s+const\s+proxy\s*=/m);
  });

  it('src/proxy.ts は runtime の route segment config を持たない', () => {
    // 入口ファイルの中身を文字列として読み込む
    const source = readFileSync(PROXY_PATH, 'utf8');
    // proxy は常に Node.js ランタイムで動くため `runtime` の指定は許されず、
    // 書くと Next.js がビルドエラー (E1031) にする。CI のビルドを待たずここで落とす。
    // 行頭アンカーなのは、ファイル冒頭の解説コメントが同じ字面を含むため
    // (実際そのままだとこのテストが自分のコメントに反応して落ちた)
    expect(source).not.toMatch(/^\s*export\s+const\s+runtime\s*=/m);
  });

  it('src/proxy.ts の matcher が静的アセットを除外したままである', () => {
    // 入口ファイルの中身を文字列として読み込む
    const source = readFileSync(PROXY_PATH, 'utf8');
    // 除外が壊れると全静的アセットが認証ガードを通り、無駄な DB アクセスと遅延を生む。
    // 逆に除外を広げすぎると保護対象が素通りするので、この 1 行は意図的に固定する
    expect(source).toContain('/((?!_next/static|_next/image|favicon.ico).*)');
  });
});
