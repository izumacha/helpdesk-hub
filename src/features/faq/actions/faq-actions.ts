'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { isAgent } from '@/lib/role';

export async function createFaqCandidate(ticketId: string, question: string, answer: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error('Unauthorized');
  if (!isAgent(session.user.role)) {
    throw new Error('エージェントまたは管理者のみ実行できます');
  }

  const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
  if (ticket.status !== 'Resolved') {
    throw new Error('解決済みチケットのみFAQ候補に変換できます');
  }

  await prisma.faqCandidate.create({
    data: {
      ticketId,
      createdById: session.user.id,
      question: question.trim(),
      answer: answer.trim(),
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

  const faq = await prisma.faqCandidate.findUniqueOrThrow({ where: { id: faqId } });
  if (faq.status !== 'Candidate') {
    throw new Error('候補ステータスのFAQのみ公開・却下できます');
  }

  await prisma.faqCandidate.update({ where: { id: faqId }, data: { status } });
  revalidatePath('/faq');
}
