// 生成された Prisma クライアントの型 (DB 操作の窓口) をインポート
import type { PrismaClient } from '@/generated/prisma';
// ドライバアダプタ込みでクライアントを組み立てる共通ファクトリをインポート
import { createPrismaClient } from './prisma-client';

// PrismaClient が二重に作られないよう、グローバル変数を借りてプロセス内で 1 つに固定する。
//
// キャッシュが必要な理由は 2 つある (どちらも「同じプロセス内でこのモジュールが 2 回評価される」問題):
//   1. 開発時のホットリロード … 再評価のたびに新しいクライアントが積み上がる。
//   2. **proxy (`src/proxy.ts`) と app サーバーのバンドル分離 (issue #298)** … Next.js は
//      リクエスト入口 (proxy) を app サーバーとは別チャンクにバンドルするため、同一プロセス上に
//      モジュールレジストリが 2 つ存在する。`auth` の `jwt` コールバックは proxy 側から
//      Prisma を呼ぶので、globalThis を挟まないと**接続プールが 2 本**張られる
//      (実測: `connection_limit=1` で app 側だけ叩くと 1 接続、proxy 側も通ると 2 接続)。
//      プール数は既定で `CPU 数 * 2 + 1` なので、8 コアなら 17 → 34 接続に倍増し、
//      Postgres の `max_connections` を圧迫する。枯渇すると `jwt` コールバックが
//      接続待ちで失敗し、#298 で直したはずの「ログイン中のユーザーが /login に弾かれる」に戻る。
//
// そのため **本番も含めて常に** globalThis にキャッシュする (下の代入に環境の条件を付けない)。
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined; // グローバルに保持する Prisma インスタンス (未定義の可能性あり)
};

// 実際に DB へ触るまでクライアントを作らないための遅延生成関数。
//
// Prisma 7 はドライバアダプタ必須になり、生成時点で接続文字列を要求する (未設定なら
// createPrismaClient が fail-closed で落ちる)。一方このモジュールは `@/data` 経由で
// **DB を触らないユニットテストからも import される**ため、モジュール評価と同時に
// クライアントを組み立てると DATABASE_URL 未設定の環境で import しただけで落ちる
// (ユニットテストに DB 依存を持ち込まないという CLAUDE.md §11 の境界が壊れる)。
// そこで生成を初回アクセスまで遅らせ、fail-closed の検査は「実際に使うとき」に効かせる。
function getPrismaClient(): PrismaClient {
  // 既に生成済みならそれを返す (globalThis キャッシュ: 上のコメントの理由で本番も含め常に使う)
  globalForPrisma.prisma ??= createPrismaClient({
    // 開発環境では error と warn を表示、本番では error のみに絞る
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });
  // キャッシュ済みのインスタンスを返す
  return globalForPrisma.prisma;
}

// 既存の呼び出し側 (`prisma.ticket.findMany()` など) を変えずに遅延生成を挟むための Proxy。
// プロパティに触れた瞬間に初めて実クライアントを生成し、以降はキャッシュを使う。
// ターゲットは空オブジェクトなので、**すべての操作を実クライアントへ転送する**必要がある
// (get/has だけだと Object.keys() や代入が空のターゲット側に落ちて黙って食い違う)。
export const prisma = new Proxy({} as PrismaClient, {
  // プロパティ読み取り (prisma.ticket / prisma.$transaction など) を実クライアントへ委譲する
  get(_target, property, receiver) {
    // 実クライアントを取得する (初回のみ生成される)
    const client = getPrismaClient();
    // 目的のプロパティを取り出す
    const value = Reflect.get(client, property, receiver);
    // メソッドは this が実クライアントを指すように束ね直してから返す
    return typeof value === 'function' ? value.bind(client) : value;
  },
  // プロパティ代入 (テストで $transaction を差し替える等) を実クライアントへ反映する
  set(_target, property, value) {
    return Reflect.set(getPrismaClient(), property, value);
  },
  // `in` 演算子やプロパティ存在確認も実クライアントに合わせる
  has(_target, property) {
    return Reflect.has(getPrismaClient(), property);
  },
  // Object.keys() / スプレッド展開が空にならないよう、キー一覧も実クライアントから返す
  ownKeys(_target) {
    return Reflect.ownKeys(getPrismaClient());
  },
  // ownKeys と対で必要 (記述子を返せないとキー列挙が実際には空になる)
  getOwnPropertyDescriptor(_target, property) {
    // 実クライアント側の記述子を取得する
    const descriptor = Reflect.getOwnPropertyDescriptor(getPrismaClient(), property);
    // Proxy の不変条件を満たすため、存在するキーは configurable: true にして返す
    return descriptor ? { ...descriptor, configurable: true } : undefined;
  },
  // delete 演算子も実クライアントへ転送する
  deleteProperty(_target, property) {
    return Reflect.deleteProperty(getPrismaClient(), property);
  },
});
