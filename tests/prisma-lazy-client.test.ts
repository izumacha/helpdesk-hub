// `src/lib/prisma.ts` の遅延生成 Proxy が守っている約束を固定するテスト。
//
// なぜテストで縛るのか:
//   この Proxy は 8 つのトラップを手書きしており、壊れても**実行時にその経路を通ったときだけ**
//   表面化する。とくに次の 2 つは静かに壊れる:
//   (a) 「DB を触らないユニットテストが import しただけでは接続文字列を要求しない」
//       (CLAUDE.md §11 の境界。壊れると `@/data` を import する全テストが道連れになる)。
//   (b) 「メソッドの参照が毎回変わらない」「Object.keys が空にならない」
//       (トラップを 1 つ落とすと、エラーではなく**黙って違う値**を返す形で壊れる)。
//
// DB へは接続しない: node-postgres のプールは遅延接続なので、クライアントを組み立てるだけなら
// 通信は発生しない (ダミーの接続先で足りる。CLAUDE.md §11 のユニットテストの境界を保つ)。

// Vitest の DSL
import { afterEach, describe, expect, it, vi } from 'vitest';

// 接続はしないが形式として妥当な DSN (実在しないホストではなく、接続を張らないので何でもよい)
const DUMMY_DATABASE_URL = 'postgresql://user:password@localhost:5432/dummy';

describe('src/lib/prisma.ts の遅延生成 Proxy', () => {
  afterEach(() => {
    // 環境変数の差し替えとモジュールキャッシュを毎回戻す (他のテストへ影響させない)
    vi.unstubAllEnvs();
    vi.resetModules();
    // **globalThis のキャッシュも消す**。src/lib/prisma.ts は生成したクライアントを
    // globalThis に載せるため、ここを消さないと resetModules だけでは前のテストの
    // クライアントが生き残り、「DATABASE_URL 未設定なら落ちる」検査がテストの並び順で
    // 通ったり通らなかったりする (実測: 順番を入れ替えると落ちなくなる)
    delete (globalThis as { prisma?: unknown }).prisma;
  });

  it('DATABASE_URL が無くても import だけなら失敗しない', async () => {
    // 接続文字列を未設定にする (CI やローカルで設定済みでも、この検査の間だけ外す)
    vi.stubEnv('DATABASE_URL', undefined);
    // import 自体が例外を投げないことを確かめる (ここが CLAUDE.md §11 の境界)
    const prismaModule = await import('@/lib/prisma');
    // 名前は生えているが、この時点ではまだクライアントを作っていない
    expect(prismaModule.prisma).toBeDefined();
  });

  it('DATABASE_URL が無いまま実際に使うと fail-closed で落ちる', async () => {
    // 接続文字列を未設定にする
    vi.stubEnv('DATABASE_URL', undefined);
    // モジュールを読み込む
    const { prisma } = await import('@/lib/prisma');
    // プロパティに触れて初めてクライアントを組み立てるので、ここで落ちるのが正しい
    expect(() => prisma.ticket).toThrow(/DATABASE_URL/);
  });

  it('メソッドの参照が毎回変わらない (登録したハンドラを同じ参照で解除できる)', async () => {
    // ダミーの接続先を設定する (接続はしない)
    vi.stubEnv('DATABASE_URL', DUMMY_DATABASE_URL);
    // モジュールを読み込む
    const { prisma } = await import('@/lib/prisma');
    // 2 回読んだメソッドが同一参照であることを確かめる
    expect(prisma.$transaction).toBe(prisma.$transaction);
  });

  it('Object.keys / スプレッドが空にならない (キー列挙が実クライアントに届く)', async () => {
    // ダミーの接続先を設定する
    vi.stubEnv('DATABASE_URL', DUMMY_DATABASE_URL);
    // モジュールを読み込む
    const { prisma } = await import('@/lib/prisma');
    // ownKeys と getOwnPropertyDescriptor の両方が要る検査 (片方欠けると 0 件になる)
    expect(Object.keys(prisma).length).toBeGreaterThan(0);
  });

  it('defineProperty と getPrototypeOf が実クライアントへ転送される', async () => {
    // ダミーの接続先を設定する
    vi.stubEnv('DATABASE_URL', DUMMY_DATABASE_URL);
    // モジュールと、比較用に実クライアントを作るファクトリを読み込む
    const { prisma } = await import('@/lib/prisma');
    const { createPrismaClient } = await import('@/lib/prisma-client');
    // 空のターゲットへ落ちると get 側からは見えないので、定義が届いているかを確かめる
    Object.defineProperty(prisma, 'testProbe', { value: 1, configurable: true });
    expect((prisma as unknown as { testProbe?: number }).testProbe).toBe(1);
    // プロトタイプも素の Object ではなく実クライアントのものになっていることを確かめる
    expect(Object.getPrototypeOf(prisma)).toBe(Object.getPrototypeOf(createPrismaClient()));
  });
});
