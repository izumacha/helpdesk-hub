import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { repos } from '@/data';
import { calculateResolutionDueAt } from '@/lib/sla';
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

  const { title, body: ticketBody, priority, categoryId } = parsed.data;
  const now = new Date();

  const ticket = await repos.tickets.create({
    title,
    body: ticketBody,
    priority,
    categoryId: categoryId ?? null,
    creatorId: session.user.id,
    resolutionDueAt: calculateResolutionDueAt(priority, now),
  });

  return NextResponse.json(ticket, { status: 201 });
}
