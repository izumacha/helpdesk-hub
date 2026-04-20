// next-auth (認証ライブラリ) の本体関数
import NextAuth from 'next-auth';
// 認証方式としてメール+パスワードを扱う Credentials プロバイダ
import Credentials from 'next-auth/providers/credentials';
// bcryptjs のパスワード照合関数 (ハッシュと平文を安全に比較)
import { compare } from 'bcryptjs';
// Prisma クライアント (ユーザー取得に使用)
import { prisma } from '@/lib/prisma';
// ロール (権限) 型
import type { Role } from '@/generated/prisma';

// 本番環境で使ってはいけない「弱い/既定値」のシークレット一覧
const WEAK_NEXTAUTH_SECRETS = new Set([
  'change-me-in-production',
  'your-secret-key-here',
  'secret',
  '',
]);

// 環境変数から NextAuth のシークレットを取得
const secret = process.env.NEXTAUTH_SECRET;
// シークレットが未設定なら警告 (サーバー再起動でセッションが失効する危険)
if (!secret) {
  console.warn(
    '[auth] NEXTAUTH_SECRET is not set — sessions will not be verifiable across restarts.',
  );
  // シークレットが既知の弱い値なら、本番投入前に強固な値に差し替えるよう警告
} else if (WEAK_NEXTAUTH_SECRETS.has(secret)) {
  console.warn(
    '[auth] NEXTAUTH_SECRET is set to a known placeholder value. Generate a strong secret (e.g. `openssl rand -base64 32`) before deploying.',
  );
}

// NextAuth の初期化。後で使う handlers / auth / signIn / signOut を取り出す
export const { handlers, auth, signIn, signOut } = NextAuth({
  // 有効化する認証プロバイダの配列
  providers: [
    Credentials({
      name: 'Credentials', // プロバイダ表示名
      // 入力フィールド定義 (ラベル・入力タイプ)
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      // 実際の認証ロジック。成功ならユーザーオブジェクト、失敗なら null を返す
      async authorize(credentials) {
        // 入力不足ならすぐ失敗
        if (!credentials?.email || !credentials?.password) return null;

        // email で User テーブルを検索
        const user = await prisma.user.findUnique({
          where: { email: credentials.email as string },
        });

        // ユーザー未存在、またはパスワード未設定なら失敗
        if (!user || !user.passwordHash) return null;

        // 入力パスワードを DB のハッシュと比較 (bcrypt)
        const isValid = await compare(credentials.password as string, user.passwordHash);
        // 一致しなければ失敗
        if (!isValid) return null;

        // 認証成功: セッションに乗せるユーザー情報を返す
        return {
          id: user.id, // ユーザー ID
          email: user.email, // メール
          name: user.name, // 氏名
          role: user.role, // 権限
        };
      },
    }),
  ],
  // JWT / セッションに独自情報を乗せるためのコールバック群
  callbacks: {
    // JWT 発行時に呼ばれる。初回ログイン時だけ user が渡ってくる
    async jwt({ token, user }) {
      // user があれば ID と role を JWT ペイロードに記録
      if (user) {
        token.id = user.id;
        token.role = (user as { role: Role }).role;
      }
      // 更新したトークンを返す
      return token;
    },
    // セッション取得時に呼ばれる。JWT の値をセッションに転記する
    async session({ session, token }) {
      // JWT があれば session.user に id と role を載せる
      if (token) {
        session.user.id = token.id as string;
        session.user.role = token.role as Role;
      }
      // 完成したセッションを返す
      return session;
    },
  },
  // カスタムログインページのパス
  pages: {
    signIn: '/login',
  },
});
