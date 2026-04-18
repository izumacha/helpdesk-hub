import { z } from 'zod';

export const pageParamSchema = z.coerce.number().int().min(1).catch(1);

export function parsePageParam(raw: unknown): number {
  return pageParamSchema.parse(raw);
}

export function clampPage(page: number, totalPages: number): number {
  if (totalPages <= 0) return 1;
  return Math.min(Math.max(page, 1), totalPages);
}
