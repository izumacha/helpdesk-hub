import type { FaqCandidate, FaqStatus } from '@/domain/types';

export interface CreateFaqInput {
  ticketId: string;
  createdById: string;
  question: string;
  answer: string;
}

export interface FaqListItem extends FaqCandidate {
  ticket: { id: string; title: string };
  createdBy: { name: string };
}

export interface FaqRepository {
  findById(id: string): Promise<FaqCandidate | null>;
  list(): Promise<FaqListItem[]>;
  create(input: CreateFaqInput): Promise<FaqCandidate>;
  updateStatus(id: string, status: FaqStatus): Promise<void>;
}
