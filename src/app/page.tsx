// 別パスへリダイレクトする Next.js のヘルパー
import { redirect } from 'next/navigation';

// ルートパス "/" にアクセスされたら問い合わせ一覧へ転送する
export default function Home() {
  // /tickets へリダイレクト (このコンポーネントは何もレンダリングしない)
  redirect('/tickets');
}
