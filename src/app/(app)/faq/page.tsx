import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { notFound } from 'next/navigation';
import { isAgent } from '@/lib/role';
import { FAQ_STATUS_LABELS, FAQ_STATUS_COLORS } from '@/lib/constants';
import { updateFaqStatus } from '@/features/faq/actions/faq-actions';

export default async function FaqPage() {
  const session = await auth();
  if (!session?.user?.id) return null;
  if (!isAgent(session.user.role)) notFound();

  const faqs = await prisma.faqCandidate.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      question: true,
      answer: true,
      status: true,
      ticket: { select: { id: true, title: true } },
      createdBy: { select: { name: true } },
    },
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">FAQ候補一覧</h1>

      {faqs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 py-16 text-center text-gray-400">
          FAQ候補はまだありません
        </div>
      ) : (
        <div className="space-y-4">
          {faqs.map((faq) => (
            <div key={faq.id} className="rounded-lg bg-white p-5 shadow-sm">
              <div className="mb-2 flex items-center justify-between">
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${FAQ_STATUS_COLORS[faq.status] ?? ''}`}
                >
                  {FAQ_STATUS_LABELS[faq.status] ?? faq.status}
                </span>
                <span className="text-xs text-gray-400">
                  登録者: {faq.createdBy.name} / 元チケット:{' '}
                  <a
                    href={`/tickets/${faq.ticket.id}`}
                    className="text-blue-600 hover:underline"
                  >
                    {faq.ticket.title}
                  </a>
                </span>
              </div>

              <h3 className="mb-1 font-semibold text-gray-800">Q. {faq.question}</h3>
              <p className="whitespace-pre-wrap text-sm text-gray-600">A. {faq.answer}</p>

              {faq.status === 'Candidate' && (
                <div className="mt-3 flex gap-2">
                  <form action={updateFaqStatus.bind(null, faq.id, 'Published')}>
                    <button
                      type="submit"
                      className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700"
                    >
                      公開する
                    </button>
                  </form>
                  <form action={updateFaqStatus.bind(null, faq.id, 'Rejected')}>
                    <button
                      type="submit"
                      className="rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
                    >
                      却下
                    </button>
                  </form>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
