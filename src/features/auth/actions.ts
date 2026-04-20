'use server';

// ログアウト処理を行う next-auth のヘルパー関数をインポート
import { signOut } from '@/lib/auth';

// ログアウトを実行するサーバーアクション (ログアウト後は /login にリダイレクト)
export async function logout() {
  // next-auth にサインアウトを依頼し、完了後にログインページへ遷移させる
  await signOut({ redirectTo: '/login' });
}
