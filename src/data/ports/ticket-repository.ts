import type {
  Priority,
  Ticket,
  TicketStatus,
  TicketWithRefs,
  UserSummary,
  TicketComment,
  TicketHistory,
} from '@/domain/types';
import type { Page, Sort, TextFilter } from './filters';

export interface TicketListFilter {
  creatorId?: string;
  /** Searches title OR body. */
  text?: TextFilter;
  status?: TicketStatus;
  priority?: Priority;
  categoryId?: string;
  /**
   * `undefined` = no filter, `null` or `'unassigned'` = only unassigned,
   * otherwise = exact match on assigneeId.
   */
  assigneeId?: string | null | 'unassigned';
}

export interface TicketDetail extends TicketWithRefs {
  comments: Array<TicketComment & { author: UserSummary }>;
  histories: Array<TicketHistory & { changedBy: UserSummary }>;
  faqCandidate: { id: string } | null;
}

export interface AssigneeWorkloadRow {
  assigneeId: string | null;
  count: number;
}

export interface CreateTicketInput {
  title: string;
  body: string;
  priority: Priority;
  categoryId: string | null;
  creatorId: string;
  firstResponseDueAt?: Date | null;
  resolutionDueAt?: Date | null;
}

export interface MarkEscalatedInput {
  reason: string;
  at: Date;
}

export interface TicketRepository {
  findById(id: string): Promise<Ticket | null>;
  findByIdWithRefs(id: string): Promise<TicketWithRefs | null>;
  findByIdWithDetail(id: string): Promise<TicketDetail | null>;

  list(args: {
    filter: TicketListFilter;
    page: Page;
    sort?: Sort<'createdAt'>;
  }): Promise<TicketWithRefs[]>;

  count(filter: TicketListFilter): Promise<number>;

  countByStatus(args: { creatorId?: string; status: TicketStatus }): Promise<number>;
  countSlaOverdue(now: Date): Promise<number>;
  workloadByAssignee(args: { excludeStatuses: TicketStatus[] }): Promise<AssigneeWorkloadRow[]>;

  create(input: CreateTicketInput): Promise<TicketWithRefs>;
  updateStatus(id: string, status: TicketStatus, resolvedAt: Date | null): Promise<void>;
  updatePriority(id: string, priority: Priority): Promise<void>;
  updateAssignee(id: string, assigneeId: string | null): Promise<void>;
  markEscalated(id: string, args: MarkEscalatedInput): Promise<void>;
}
