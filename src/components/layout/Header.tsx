// React の Suspense (子の読み込み待ち時にフォールバック表示)
import { Suspense } from 'react';
// セッション (ログイン情報) 取得
import { auth } from '@/lib/auth';
// 通知ベル (未読件数バッジ付きリンク)
import { NotificationBell } from './NotificationBell';
// ログアウト用サーバーアクション
import { logout } from '@/features/auth/actions';

// 画面上部の共通ヘッダー (右側に通知 / ユーザー名 / ログアウトボタン)
export async function Header() {
  // 現在のセッションを取得
  const session = await auth();

  return (
    <header className="flex h-14 items-center justify-between border-b border-gray-200 bg-white px-6">
      {/* 左側は将来用 (今は空) */}
      <div />
      {/* 右側: ログイン中ユーザー向けのコントロール群 */}
      <div className="flex items-center gap-4">
        {session?.user && (
          <>
            {/* 通知ベル (未読件数取得中はフォールバックを表示) */}
            <Suspense fallback={<span className="text-sm text-gray-700">通知</span>}>
              <NotificationBell userId={session.user.id!} />
            </Suspense>
            {/* ユーザー名と権限 */}
            <span className="text-sm text-gray-700">
              {session.user.name}（{session.user.role}）
            </span>
            {/* ログアウトフォーム (Server Action を直接 action に渡す) */}
            <form action={logout}>
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
