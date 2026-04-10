import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { createTicketSchema } from '@/lib/validations/ticket';

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'リクエストの形式が正しくありません' }, { status: 400 });
  }

  const parsed = createTicketSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: '入力値が正しくありません', issues: parsed.error.issues },
      { status: 422 },
    );
  }

  const { title, body: ticketBody, categoryId, priority } = parsed.data;

  const ticket = await prisma.ticket.create({
    data: {
      title,
      body: ticketBody,
      priority,
      categoryId,
      creatorId: session.user.id,
    },
    include: { category: true, creator: { select: { id: true, name: true } } },
  });

  return NextResponse.json(ticket, { status: 201 });
}
