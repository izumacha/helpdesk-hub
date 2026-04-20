// 生成された Prisma クライアント (DB 操作の窓口) をインポート
import { PrismaClient } from '@/generated/prisma';

// 開発時のホットリロードで PrismaClient が大量生成されないよう、グローバル変数を借りてキャッシュする
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

// 本番以外 (dev/test) では作成した prisma をグローバルにキャッシュして再利用可能にする
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
