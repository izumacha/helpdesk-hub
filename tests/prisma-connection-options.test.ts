// 接続文字列のプール関連パラメータが node-postgres の設定へ読み替えられることを固定するテスト。
//
// なぜテストで縛るのか:
//   Prisma 5 のクエリエンジンは `connection_limit` / `pool_timeout` / `connect_timeout` を
//   自分で解釈していたが、Prisma 7 のドライバアダプタは**どれも読まない**。読み替えを
//   忘れると、プール上限は既定の 10 に戻り、待ち時間は「無期限」になる。後者がとくに悪く、
//   DB が詰まったり到達不能になったときにエラーではなく**ハング**する
//   (リクエストが返らず、`jwt` コールバック経由でログイン中のユーザーが弾かれる: issue #298)。
//   実接続を張らずにこの読み替えだけを確かめるため、アダプタへ渡る設定を覗いて検証する。
//
// DB へは接続しない: node-postgres のプールは遅延接続で、生成しただけでは通信しない。

// Vitest の DSL
import { afterEach, describe, expect, it, vi } from 'vitest';

// 接続はしないが形式として妥当な DSN
const BASE_DSN = 'postgresql://user:password@localhost:5432/dummy';

// アダプタへ渡された設定を覗くために、@prisma/adapter-pg をモックする
const capturedConfigs: Record<string, unknown>[] = [];
vi.mock('@prisma/adapter-pg', () => ({
  // PrismaPg の代わりに、第 1 引数 (node-postgres の設定) を記録するだけのクラスを使う
  PrismaPg: class {
    constructor(config: Record<string, unknown>) {
      capturedConfigs.push(config);
    }
  },
}));

// 生成クライアントもモックする。本物はアダプタの形を検証するため、記録用のダミーでは通らない
// (ここで見たいのは「アダプタへ何を渡したか」だけなので、クライアント本体は空で足りる)
vi.mock('@/generated/prisma', () => ({
  // 生成された PrismaClient の代わりに、何もしないクラスを使う
  PrismaClient: class {},
  // 型としてしか使わないが、実行時 import に備えて空オブジェクトを置く
  Prisma: {},
}));

// 指定した DSN でクライアントを作り、アダプタへ渡された設定を返す
async function captureAdapterConfig(dsn: string): Promise<Record<string, unknown>> {
  // 接続文字列を差し替える
  vi.stubEnv('DATABASE_URL', dsn);
  // モジュールを読み直してファクトリを取得する
  const { createPrismaClient } = await import('@/lib/prisma-client');
  // クライアントを組み立てる (モックしたアダプタが設定を記録する)
  createPrismaClient();
  // 直前に記録された設定を返す
  return capturedConfigs[capturedConfigs.length - 1];
}

describe('接続文字列のプール設定の読み替え', () => {
  afterEach(() => {
    // 環境変数とモジュールキャッシュを毎回戻す
    vi.unstubAllEnvs();
    vi.resetModules();
    // 記録も空にする
    capturedConfigs.length = 0;
  });

  it('指定が無ければ Prisma 5 と同じ 10 秒の待ち時間を設定する', async () => {
    // 何も付けない既定の DSN で作る
    const config = await captureAdapterConfig(BASE_DSN);
    // 無期限待ちにならないことを確かめる (ここが未設定だと node-postgres は永遠に待つ)
    expect(config.connectionTimeoutMillis).toBe(10_000);
    // プール上限は node-postgres の既定に任せる (指定しない)
    expect(config.max).toBeUndefined();
  });

  it('connection_limit をプール上限へ読み替える', async () => {
    // 上限 2 を指定した DSN で作る
    const config = await captureAdapterConfig(`${BASE_DSN}?connection_limit=2`);
    // node-postgres の max として渡ることを確かめる
    expect(config.max).toBe(2);
  });

  it('pool_timeout を待ち時間へ読み替える (秒 → ミリ秒)', async () => {
    // 待ち時間 3 秒を指定した DSN で作る
    const config = await captureAdapterConfig(`${BASE_DSN}?pool_timeout=3`);
    // ミリ秒へ変換して渡ることを確かめる
    expect(config.connectionTimeoutMillis).toBe(3_000);
  });

  it('pool_timeout が無ければ connect_timeout を使う', async () => {
    // 接続確立の上限だけを指定した DSN で作る
    const config = await captureAdapterConfig(`${BASE_DSN}?connect_timeout=4`);
    // node-postgres は待ち時間の設定口が 1 つなので、そちらへ反映する
    expect(config.connectionTimeoutMillis).toBe(4_000);
  });

  it('pool_timeout=0 は「待ち続ける」としてそのまま渡す (Prisma と同じ意味)', async () => {
    // 0 を指定した DSN で作る
    const config = await captureAdapterConfig(`${BASE_DSN}?pool_timeout=0`);
    // 0 は node-postgres でも「タイムアウト無し」を意味する
    expect(config.connectionTimeoutMillis).toBe(0);
  });

  it('不正な値は黙って既定へ倒さず落とす', async () => {
    // 数値でない値を指定する
    vi.stubEnv('DATABASE_URL', `${BASE_DSN}?connection_limit=abc`);
    // ファクトリを読み込む
    const { createPrismaClient } = await import('@/lib/prisma-client');
    // 設定ミスに気付けるよう、その場で落ちることを確かめる (fail-closed)
    expect(() => createPrismaClient()).toThrow(/connection_limit/);
  });

  it('?schema= 未指定で DSN が search_path を指定していればそれを尊重する', async () => {
    // 拡張機能を別スキーマに置くマネージド Postgres で使われる形
    const config = await captureAdapterConfig(
      `${BASE_DSN}?options=${encodeURIComponent('-c search_path=public,extensions')}`,
    );
    // こちらから search_path を上書きしない (接続文字列をそのまま使う)
    expect(config.options).toBeUndefined();
    expect(config.connectionString).toContain('search_path');
  });

  it('?schema= があれば DSN の search_path 指定より優先する', async () => {
    // スキーマの主張が明示されている場合は、そちらを唯一の真実として固定する
    const config = await captureAdapterConfig(
      `${BASE_DSN}?schema=app&options=${encodeURIComponent('-c search_path=public')}`,
    );
    // DSN 側の指定を活かしつつ、最後に自分の search_path を置いて効かせる
    expect(config.options).toBe('-c search_path=public -c search_path="app"');
  });
});
