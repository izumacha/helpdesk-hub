// Prisma クライアント本体と、トランザクション内で使う Prisma クライアント型をインポート
import type { Prisma, PrismaClient } from '@/generated/prisma';

// 通常クライアントでもトランザクション中のクライアントでも受け取れる共通型
// (リポジトリ実装が両方のコンテキストで使えるようにするための型エイリアス)
export type PrismaLike = PrismaClient | Prisma.TransactionClient;
