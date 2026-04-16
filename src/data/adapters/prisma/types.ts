import type { Prisma, PrismaClient } from '@/generated/prisma';

export type PrismaLike = PrismaClient | Prisma.TransactionClient;
