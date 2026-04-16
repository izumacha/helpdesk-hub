import type { HistoryField } from '@/domain/types';

export interface RecordHistoryInput {
  ticketId: string;
  changedById: string;
  field: HistoryField;
  oldValue: string | null;
  newValue: string | null;
}

export interface TicketHistoryRepository {
  record(input: RecordHistoryInput): Promise<void>;
}
