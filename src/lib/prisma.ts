// 生成された Prisma クライアント (DB 操作の窓口) をインポート
import { PrismaClient } from '@/generated/prisma';

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

// 既に生成済みのインスタンスがあればそれを再利用し、無ければ新しく作成する
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    // 開発環境では error と warn を表示、本番では error のみに絞る
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });

// 作成した prisma をグローバルにキャッシュし、次回の評価では上の `??` で再利用させる。
// 環境で分岐しないのは上のコメントのとおり (本番こそ proxy / app サーバーの二重生成を防ぎたい)。
globalForPrisma.prisma = prisma;
