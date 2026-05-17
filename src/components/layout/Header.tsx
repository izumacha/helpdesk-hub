// React の Suspense (子の読み込み待ち時にフォールバック表示)
import { Suspense } from 'react';
// セッション (ログイン情報) 取得
import { auth } from '@/lib/auth';
// 通知ベル (未読件数バッジ付きリンク)
import { NotificationBell } from './NotificationBell';
// モバイル用ハンバーガーボタン (md 未満でサイドバードロワーを開閉する)
import { MobileNavToggle } from './MobileNavToggle';
// ログアウト用サーバーアクション
import { logout } from '@/features/auth/actions/logout';

// ロール表示用の日本語ラベル (技術名を画面に出さないため)
const ROLE_LABELS: Record<string, string> = {
  admin: '管理者',
  agent: '担当者',
  requester: '依頼者',
};

// 名前から最大 2 文字のイニシャル (アバター用) を作る
// 日本語名は先頭 1 文字、英語名は単語頭を 2 文字に
function getInitials(name: string | null | undefined): string {
  // 名前が無ければ空文字
  if (!name) return '';
  // 半角スペース区切りの英語名はそれぞれ頭文字を取り 2 文字に
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  // それ以外 (日本語名など) は先頭 1 文字
  return parts[0][0] ?? '';
}

// 画面上部の共通ヘッダー (右側に通知 / ユーザー名 / ログアウトボタン)
export async function Header() {
  // 現在のセッションを取得
  const session = await auth();
  // ロール文字列を日本語ラベルに変換 (未知の値はそのまま表示)
  const roleLabel = session?.user?.role
    ? (ROLE_LABELS[session.user.role] ?? session.user.role)
    : '';
  // 担当者 / 管理者なら強調色、依頼者ならニュートラルなロール pill 色
  const rolePillClass =
    session?.user?.role === 'requester'
      ? 'bg-slate-100 text-slate-600'
      : 'bg-teal-50 text-teal-800 ring-1 ring-teal-200';

  return (
    <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-white/85 px-4 backdrop-blur sm:px-6">
      {/* 左側: モバイル時のみ表示するハンバーガーボタン (デスクトップは Sidebar 常時表示) */}
      <MobileNavToggle />
      {/* 右側: ログイン中ユーザー向けのコントロール群 (モバイルでは間隔を狭くする) */}
      <div className="flex items-center gap-2 sm:gap-4">
        {session?.user && (
          <>
            {/* 通知ベル (未読件数取得中はフォールバックを表示、tenantId スコープ) */}
            <Suspense fallback={<span className="text-sm text-slate-500">通知</span>}>
              <NotificationBell userId={session.user.id!} tenantId={session.user.tenantId} />
            </Suspense>
            {/* ユーザー情報: アバター丸 + 氏名 + ロール pill (モバイルではアバターのみ) */}
            <div className="flex items-center gap-2.5">
              {/* イニシャルを表示する円形アバター (ティール背景) */}
              <span
                aria-hidden
                className="flex h-9 w-9 items-center justify-center rounded-full bg-teal-700 text-xs font-semibold text-white"
              >
                {getInitials(session.user.name)}
              </span>
              {/* 氏名 (モバイルでは省略してアバターだけにする) */}
              <span className="hidden text-sm font-medium text-slate-700 sm:inline">
                {session.user.name}
              </span>
              {/* ロールを示す小さな pill (モバイルでは省略) */}
              <span
                className={`hidden rounded-full px-2 py-0.5 text-[11px] font-medium sm:inline ${rolePillClass}`}
              >
                {roleLabel}
              </span>
            </div>
            {/* ログアウトフォーム (Server Action を直接 action に渡す) */}
            <form action={logout}>
              <button
                type="submit"
                className="rounded-lg px-2 py-1.5 text-sm text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 sm:px-3"
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
