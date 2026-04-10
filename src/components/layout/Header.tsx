import { auth, signOut } from '@/lib/auth';

export async function Header() {
  const session = await auth();

  return (
    <header className="flex h-14 items-center justify-between border-b border-gray-200 bg-white px-6">
      <div />
      <div className="flex items-center gap-4">
        {session?.user && (
          <>
            <span className="text-sm text-gray-700">
              {session.user.name}（{session.user.role}）
            </span>
            <form
              action={async () => {
                'use server';
                await signOut({ redirectTo: '/login' });
              }}
            >
              <button
                type="submit"
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
              >
                ログアウト
              </button>
            </form>
          </>
        )}
      </div>
    </header>
  );
}
