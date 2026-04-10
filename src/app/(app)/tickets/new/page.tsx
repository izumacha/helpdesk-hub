import { prisma } from '@/lib/prisma';
import { TicketForm } from '@/features/tickets/components/TicketForm';

export default async function NewTicketPage() {
  const categories = await prisma.category.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-6 text-2xl font-bold text-gray-900">問い合わせ 新規登録</h1>
      <div className="rounded-lg bg-white p-6 shadow-sm">
        <TicketForm categories={categories} />
      </div>
    </div>
  );
}
