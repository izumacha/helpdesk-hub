export default function TicketsPage() {
  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">問い合わせ一覧</h1>
        <a
          href="/tickets/new"
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          新規登録
        </a>
      </div>
      <p className="text-gray-500">問い合わせ一覧はここに表示されます。</p>
    </div>
  );
}
