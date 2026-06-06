// next-auth (認証ライブラリ) の本体関数
import NextAuth from 'next-auth';
// 認証方式としてメール+パスワードを扱う Credentials プロバイダ
import Credentials from 'next-auth/providers/credentials';
// bcryptjs のパスワード照合 (compare) と、タイミング撹乱用ダミーハッシュ生成 (hashSync)
import { compare, hashSync } from 'bcryptjs';
// データ層の Composition Root 経由でユーザー取得 (Prisma 直叩きを避ける)
import { repos } from '@/data';
// マジックリンクのトークンハッシュ計算 (生トークン -> DB 検索キー)
import { hashMagicLinkToken } from '@/lib/magic-link';
// ログイン失敗のスロットル (ブルートフォース / クレデンシャルスタッフィング対策)
import {
  clearLoginFailures,
  isLoginBlocked,
  loginEmailKey,
  loginIpKey,
  recordLoginFailure,
} from '@/lib/login-throttle';
// ロール (権限) 型
import type { Role } from '@/domain/types';

// ユーザー不在時に compare へ渡すダミー bcrypt ハッシュ。実ユーザーと同じコスト 12 で
// 計算するため、「ユーザー有無」で bcrypt の実行有無が変わらず、応答時間の差から在不在を
// 推測されるタイミングオラクルを緩和する (issue #119)。
// 遅延生成: middleware は edge ランタイムでこのモジュールを読み込むため、モジュール読込時に
// hashSync を走らせるとコールドスタートが重くなる。authorize は node ランタイムの API
// ルートでのみ実行されるので、初回ログイン試行時に 1 度だけ計算してキャッシュする。
let dummyPasswordHash: string | null = null;
// キャッシュ済みのダミーハッシュを返す (未計算なら 1 度だけ生成する)
function getDummyPasswordHash(): string {
  // まだ生成していなければここで bcrypt ハッシュを 1 度だけ計算する
  if (dummyPasswordHash === null) {
    dummyPasswordHash = hashSync('timing-decoy-not-a-real-password', 12);
  }
  // 生成済みのハッシュを返す
  return dummyPasswordHash;
}

// Request の転送ヘッダからクライアント IP を取り出す (best-effort)。
// 信頼できるプロキシ設定が無い環境では X-Forwarded-For は偽装可能なので、
// IP ベースのスロットルは補助。主たる防御はメール単位のロックアウト。
function clientIpFromRequest(request: Request | undefined): string | null {
  // request が無ければ IP 不明
  if (!request) return null;
  // X-Forwarded-For (プロキシ経由の元 IP, カンマ区切りで複数) を優先的に読む
  const forwarded = request.headers.get('x-forwarded-for');
  // 値があれば先頭 (最も手前のクライアント) を採用する
  if (forwarded) {
    // カンマで分割し、先頭要素の空白を除去して返す
    const first = forwarded.split(',')[0]?.trim();
    // 空でなければそれを IP として使う
    if (first) return first;
  }
  // 予備として X-Real-IP ヘッダも見る
  const realIp = request.headers.get('x-real-ip');
  // あれば採用、無ければ null
  return realIp?.trim() || null;
}

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
      // 実際の認証ロジック。成功ならユーザーオブジェクト、失敗なら null を返す
      // 第 2 引数 request からクライアント IP を取り出してスロットルに使う
      async authorize(credentials, request) {
        // 入力不足ならすぐ失敗
        if (!credentials?.email || !credentials?.password) return null;

        // email を小文字化して、失敗カウントのキーを大文字小文字で割れないようにする
        const email = (credentials.email as string).trim().toLowerCase();
        // メール単位の失敗カウントキー (偽装不可の主防御)
        const emailKey = loginEmailKey(email);
        // リクエストからクライアント IP を取得 (best-effort)
        const ip = clientIpFromRequest(request as Request | undefined);
        // IP 単位の失敗カウントキー (取得できた場合のみ)
        const ipKey = ip ? loginIpKey(ip) : null;

        // メールまたは IP が窓内の失敗上限に達していれば、bcrypt を実行せず即拒否する
        // (ブルートフォース / クレデンシャルスタッフィングのロックアウト)
        if (isLoginBlocked(emailKey) || (ipKey !== null && isLoginBlocked(ipKey))) {
          return null;
        }

        // email で User を検索 (port 経由)
        const user = await repos.users.findByEmail(email);

        // ユーザー未存在、またはパスワード未設定の場合
        if (!user || !user.passwordHash) {
          // ダミーハッシュと比較して bcrypt の処理時間を実在ユーザーと揃える
          // (在/不在を応答時間から推測されるのを防ぐ)。結果は捨てる。
          await compare(credentials.password as string, getDummyPasswordHash());
          // 失敗としてカウントする (スプレー攻撃のロックアウトに反映)
          recordLoginFailure(emailKey);
          // IP が分かっていれば IP 側にも失敗を記録する
          if (ipKey !== null) recordLoginFailure(ipKey);
          // 認証失敗
          return null;
        }

        // 入力パスワードを DB のハッシュと比較 (bcrypt)
        const isValid = await compare(credentials.password as string, user.passwordHash);
        // 一致しなければ失敗としてカウントしてから拒否する
        if (!isValid) {
          // メール単位の失敗を記録する
          recordLoginFailure(emailKey);
          // IP が分かっていれば IP 側にも記録する
          if (ipKey !== null) recordLoginFailure(ipKey);
          // 認証失敗
          return null;
        }

        // 認証成功: このメール / IP の失敗カウントをリセットする
        clearLoginFailures(emailKey);
        // IP が分かっていれば IP 側の失敗カウントもリセットする
        if (ipKey !== null) clearLoginFailures(ipKey);

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
