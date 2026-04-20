// next-auth の設定から生成されたリクエストハンドラ (GET/POST) を取り込む
import { handlers } from '@/lib/auth';

// /api/auth/[...nextauth] の GET/POST を next-auth のハンドラにそのまま委譲する
export const { GET, POST } = handlers;
