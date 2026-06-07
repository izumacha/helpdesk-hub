// next-auth (認証ライブラリ) の本体関数
import NextAuth from 'next-auth';
// 認証方式としてメール+パスワードを扱う Credentials プロバイダ
import Credentials from 'next-auth/providers/credentials';
// データ層の Composition Root 経由でユーザー取得 (Prisma 直叩きを避ける)
import { repos } from '@/data';
// マジックリンクのトークンハッシュ計算 (生トークン -> DB 検索キー)
import { hashMagicLinkToken } from '@/lib/magic-link';
// パスワード認証ロジック (スロットル + ダミー bcrypt 比較込み)。単体テスト可能なよう分離 (issue #119)
import { passwordAuthorize } from '@/lib/password-authorize';
// ロール (権限) 型
import type { Role } from '@/domain/types';

// 本番環境で使ってはいけない「弱い/既定値」のシークレット一覧
const WEAK_NEXTAUTH_SECRETS = new Set([
  'change-me-in-production',
  'your-secret-key-here',
  'secret',
  '',
]);

// 環境変数から NextAuth のシークレットを取得
const secret = process.env.NEXTAUTH_SECRET;
// 本番実行かどうか (NODE_ENV=production)
const isProduction = process.env.NODE_ENV === 'production';
// `next build` はこのモジュールを NODE_ENV=production で import するが、ビルド時点では
// 実行用シークレットが未設定でも正常。ビルドフェーズでは fail-fast せず実行時のみ止める。
const isBuildPhase = process.env.NEXT_PHASE === 'phase-production-build';
// シークレットが未設定、または既知の弱い/プレースホルダ値かどうかを判定
const secretIsWeak = !secret || WEAK_NEXTAUTH_SECRETS.has(secret);
// 弱い場合: 本番実行時は致命的に扱い、それ以外は警告に留める (issue #121)
if (secretIsWeak) {
  // 状況に応じた説明メッセージを組み立てる
  const detail = !secret
    ? 'NEXTAUTH_SECRET is not set'
    : 'NEXTAUTH_SECRET is set to a known placeholder/weak value';
  // 本番実行 (ビルドフェーズを除く) では、セッション偽造を防ぐため起動を止める (fail-fast)
  if (isProduction && !isBuildPhase) {
    // magic-link の NEXTAUTH_URL fail-fast と同方針で、運用に強制的に気づかせる
    throw new Error(
      `[auth] ${detail}. Generate a strong secret (e.g. \`openssl rand -base64 32\`) and set NEXTAUTH_SECRET before deploying.`,
    );
  }
  // 開発・ビルド時は警告のみ (起動は継続)
  console.warn(
    `[auth] ${detail}. Generate a strong secret (e.g. \`openssl rand -base64 32\`) before deploying to production.`,
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
      // 実際の認証ロジックは password-authorize.ts に分離 (スロットル + ダミー比較込み)。
      // 単体テストから直接 passwordAuthorize を検証できるようにするため。
      authorize: passwordAuthorize,
    }),
    // マジックリンク (メール内ワンタイム URL) を受け付ける 2 つめの Credentials プロバイダ。
    // /api/auth/magic-link/callback ルートが署名済みトークンを携えて signIn('magic-link', ...) を呼ぶ
    Credentials({
      id: 'magic-link', // 既定の Credentials Provider と区別するための ID
      name: 'MagicLink', // 表示名 (UI には出さない)
      credentials: {
        token: { label: 'Token', type: 'text' }, // 1 入力フィールドのみ: ワンタイムトークン
      },
      // トークン検証: 「未消費 + 失効前 + 存在」を 1 度の DB 更新で確定させて消費する
      async authorize(credentials) {
        // トークンが渡されていなければ失敗
        if (!credentials?.token) return null;
        // 受け取った生トークンを SHA-256 でハッシュして DB 検索キーに変換 (Web Crypto は async)
        const tokenHash = await hashMagicLinkToken(credentials.token as string);
        // 原子的に消費 (未消費 & 失効前なら自身が成功し他は null)。検索 + 検証 + 消費を 1 操作で行う
        const consumed = await repos.magicLinks.consumeValidToken({ tokenHash, now: new Date() });
        // 消費に失敗 (消費済み / 失効済み / 不在) ならログイン拒否
        if (!consumed) return null;

        // トークン作成時に保存されていた email から既存ユーザーを引く
        const user = await repos.users.findByEmail(consumed.email);
        // ユーザーが消えていれば失敗 (孤児トークン)
        if (!user) return null;

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
