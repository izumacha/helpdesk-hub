'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { isAgent } from '@/lib/role';
import { FAQ_ELIGIBLE_STATUSES } from '@/lib/constants';
import { faqCandidateSchema } from '@/lib/validations/faq';

export async function createFaqCandidate(ticketId: string, question: string, answer: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error('Unauthorized');
  if (!isAgent(session.user.role)) {
    throw new Error('エージェントまたは管理者のみ実行できます');
  }

  const parsed = faqCandidateSchema.safeParse({ question, answer });
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'FAQ候補の入力値が不正です');
  }

  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) throw new Error('チケットが見つかりません');
  if (!FAQ_ELIGIBLE_STATUSES.includes(ticket.status)) {
    throw new Error('解決済みチケットのみFAQ候補に変換できます');
  }

  await prisma.faqCandidate.create({
    data: {
      ticketId,
      createdById: session.user.id,
      question: parsed.data.question,
      answer: parsed.data.answer,
    },
  });

  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath('/faq');
}

export async function updateFaqStatus(faqId: string, status: 'Published' | 'Rejected') {
  const session = await auth();
  if (!session?.user?.id) throw new Error('Unauthorized');
  if (!isAgent(session.user.role)) {
    throw new Error('エージェントまたは管理者のみ実行できます');
  }

  const faq = await prisma.faqCandidate.findUnique({ where: { id: faqId } });
  if (!faq) throw new Error('FAQ候補が見つかりません');
  if (faq.status !== 'Candidate') {
    throw new Error('候補ステータスのFAQのみ公開・却下できます');
  }

  await prisma.faqCandidate.update({ where: { id: faqId }, data: { status } });
  revalidatePath('/faq');
}
