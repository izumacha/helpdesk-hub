export type SlaState = 'ok' | 'warning' | 'overdue' | 'none';

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
