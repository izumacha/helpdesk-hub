import type { Priority } from '@/domain/types';

export type SlaState = 'ok' | 'warning' | 'overdue' | 'none';

/**
 * Hours allowed to resolve a ticket, by priority. Placeholder business policy —
 * replace with a config/DB-backed source once requirements are finalized.
 */
export const SLA_RESOLUTION_HOURS_BY_PRIORITY: Record<Priority, number> = {
  High: 24,
  Medium: 72,
  Low: 168,
};

export function calculateResolutionDueAt(priority: Priority, from: Date): Date {
  const hours = SLA_RESOLUTION_HOURS_BY_PRIORITY[priority];
  return new Date(from.getTime() + hours * 60 * 60 * 1000);
}

export function getSlaState(resolutionDueAt: Date | null, resolvedAt: Date | null): SlaState {
  if (!resolutionDueAt) return 'none';
  if (resolvedAt) return 'ok';

  const now = new Date();
  const msLeft = resolutionDueAt.getTime() - now.getTime();

  if (msLeft < 0) return 'overdue';
  if (msLeft < 24 * 60 * 60 * 1000) return 'warning'; // within 24 h
  return 'ok';
}

export const SLA_LABELS: Record<SlaState, string> = {
  ok: '',
  warning: '期限間近',
  overdue: '期限超過',
  none: '',
};

export const SLA_COLORS: Record<SlaState, string> = {
  ok: '',
  warning: 'bg-yellow-100 text-yellow-700',
  overdue: 'bg-red-100 text-red-700',
  none: '',
};
