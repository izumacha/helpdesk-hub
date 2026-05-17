// next-auth (認証ライブラリ) の本体関数
import NextAuth from 'next-auth';
// 認証方式としてメール+パスワードを扱う Credentials プロバイダ
import Credentials from 'next-auth/providers/credentials';
// bcryptjs のパスワード照合関数 (ハッシュと平文を安全に比較)
import { compare } from 'bcryptjs';
// データ層の Composition Root 経由でユーザー取得 (Prisma 直叩きを避ける)
import { repos } from '@/data';
// マジックリンクのトークンハッシュ計算 (生トークン -> DB 検索キー)
import { hashMagicLinkToken } from '@/lib/magic-link';
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

        // email で User を検索 (port 経由)
        const user = await repos.users.findByEmail(credentials.email as string);

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
          tenantId: user.tenantId, // 所属テナント ID (マルチテナント化のキー)
        };
      },
    }),
    // マジックリンク (メール内ワンタイム URL) を受け付ける 2 つめの Credentials プロバイダ。
    // /api/auth/magic-link/callback ルートが署名済みトークンを携えて signIn('magic-link', ...) を呼ぶ
    Credentials({
      id: 'magic-link', // 既定の Credentials Provider と区別するための ID
      name: 'MagicLink', // 表示名 (UI には出さない)
      credentials: {
        token: { label: 'Token', type: 'text' }, // 1 入力フィールドのみ: ワンタイムトークン
      },
      // トークン検証: DB のハッシュ済みエントリと突き合わせ、期限・消費状態をチェックする
      async authorize(credentials) {
        // トークンが渡されていなければ失敗
        if (!credentials?.token) return null;
        // 受け取った生トークンを SHA-256 でハッシュして DB 検索キーに変換 (Web Crypto は async)
        const tokenHash = await hashMagicLinkToken(credentials.token as string);
        // ハッシュ一致のレコードを取得
        const record = await repos.magicLinks.findByTokenHash(tokenHash);
        // 見つからなければ失敗
        if (!record) return null;
        // 既に消費済みなら失敗 (単回使用)
        if (record.consumedAt) return null;
        // 失効済みなら失敗
        if (record.expiresAt < new Date()) return null;

        // トークン作成時に保存されていた email から既存ユーザーを引く
        const user = await repos.users.findByEmail(record.email);
        // ユーザーが消えていれば失敗 (孤児トークン)
        if (!user) return null;

        // 検証成功: 同じトークンを 2 度と使えなくする
        await repos.magicLinks.markConsumed(record.id);

        // セッションに乗せるユーザー情報を返す (パスワード経路と同じ shape)
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          tenantId: user.tenantId,
        };
      },
    }),
  ],
  // JWT / セッションに独自情報を乗せるためのコールバック群
  callbacks: {
    // JWT 発行時に呼ばれる。初回ログイン時だけ user が渡ってくる
    async jwt({ token, user }) {
      // user があれば ID / role / tenantId を JWT ペイロードに記録
      if (user) {
        token.id = user.id;
        token.role = (user as { role: Role }).role;
        token.tenantId = (user as { tenantId: string }).tenantId;
      }
      // 旧 JWT (Tenant 化前に発行されたもの) は tenantId を持たないので、
      // DB から引いて補完する。これがないとデプロイ直後のログイン中ユーザーが
      // session.user.tenantId = undefined になり Server Action が落ちる
      if (!token.tenantId && token.id) {
        // ユーザーを ID で検索 (port 経由)
        const fresh = await repos.users.findById(token.id as string);
        if (fresh) {
          // 見つかれば tenantId を補完
          token.tenantId = fresh.tenantId;
        } else {
          // User が DB から削除済みなら、JWT を無効化して再ログインを促す
          // (next-auth v5 は jwt callback での throw を session 失効として扱う)
          throw new Error('User no longer exists. Please sign in again.');
        }
      }
      // 更新したトークンを返す
      return token;
    },
    // セッション取得時に呼ばれる。JWT の値をセッションに転記する
    async session({ session, token }) {
      // JWT があれば session.user に id / role / tenantId を載せる
      if (token) {
        session.user.id = token.id as string;
        session.user.role = token.role as Role;
        // jwt callback で必ず string になっている (未設定なら throw 済み)
        session.user.tenantId = token.tenantId as string;
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
