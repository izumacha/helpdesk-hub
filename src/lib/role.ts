import type { Role } from '@/generated/prisma';

export function isAgent(role: Role | string | null | undefined): boolean {
  return role === 'agent' || role === 'admin';
}
