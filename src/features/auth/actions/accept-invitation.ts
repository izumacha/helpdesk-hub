'use server';

/**
 * 招待受諾サーバーアクション (公開)。
 *
 * 招待リンクのトークンと、招待された人が入力した氏名・パスワードを受け取り、
 * 招待行が指すテナント・権限でユーザーを 1 件作成する。トークンが「秘密」であることが
 * 認可の根拠なので auth() は不要 (公開アクション)。
 *
 * セキュリティ要点:
 *  - tenantId / role は **招待行 (consumeValidToken の戻り) からのみ** 取り出す。
 *    リクエスト入力には tenantId を一切含めない (クロステナント参加の防止 / §5.6)。
 *  - 消費 (単回使用ガード) とユーザー作成を 1 トランザクションで行い、作成失敗時は
 *    消費もロールバックして招待を無駄に焼かない。
 *  - パスワードは bcrypt でハッシュ化して保存する (平文は保存しない / §9)。
 */

// bcrypt によるパスワードハッシュ化 (seed と同じ cost 12)
import { hash } from 'bcryptjs';
// データ層の Composition Root (リポジトリ束とトランザクション境界)
import { repos, uow } from '@/data';
// 招待トークンのハッシュ化 (生トークン → DB 保存値と同じ SHA-256 へ)
import { hashInviteToken } from '@/lib/invite';
// 受諾フォームの入力検証スキーマと、ユーザー入力メールの検証・正規化スキーマ
import { acceptInvitationSchema, emailSchema } from '@/lib/validations/invite';

// accept の戻り値型。作成に使ったメールを返し、クライアントがそのままログインに使う
export interface AcceptInvitationResult {
  email: string; // 作成したユーザーのログイン用メール
}

// 招待を受諾してユーザーを作成するサーバーアクション。
// rawToken は受諾ページの URL から、name/password/email はフォームから渡る。
export async function acceptInvitation(
  rawToken: string,
  formData: FormData,
): Promise<AcceptInvitationResult> {
  // フォーム入力 (氏名・パスワード) を Zod で検証する
  const parsed = acceptInvitationSchema.safeParse({
    name: formData.get('name'),
    password: formData.get('password'),
  });
  // 検証失敗ならユーザー向け日本語メッセージで throw
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? '入力が正しくありません');
  }
  // 検証済みの氏名・パスワード
  const { name, password } = parsed.data;

  // 招待行に email が無い場合に使う「招待される人が自分で入力したメール」を取り出す。
  // 空文字/空白だけなら未入力扱い (null)、入力があれば共通スキーマでメール形式・長さを検証する。
  // (trim/lowercase だけだと不正形式や過大長がそのまま User.email に入り、Prisma 500 になり得る)
  const rawInputEmail = formData.get('email');
  let inputEmail: string | null = null;
  // 文字列かつ空白除去後に中身がある場合のみ検証へ回す
  if (typeof rawInputEmail === 'string' && rawInputEmail.trim() !== '') {
    // メール形式・最大長を検証し、小文字へ正規化する
    const emailParsed = emailSchema.safeParse(rawInputEmail);
    // 形式不正・過大長ならユーザー向け日本語メッセージで throw (消費前に弾く)
    if (!emailParsed.success) {
      throw new Error(emailParsed.error.issues[0]?.message ?? '正しいメールアドレスを入力してください');
    }
    // 検証済みの正規化メール
    inputEmail = emailParsed.data;
  }

  // 生トークンを DB 保存値と同じ SHA-256 ハッシュへ変換する
  const tokenHash = await hashInviteToken(rawToken);
  // 消費判定の基準時刻
  const now = new Date();

  // 消費 (単回使用ガード) → ユーザー作成を 1 トランザクションで行う。
  // 途中で例外が出れば消費もロールバックされ、招待リンクは再利用可能なまま残る。
  const result = await uow.run(async (tx) => {
    // 招待を原子的に消費する。未消費かつ失効前のときだけ成功して招待行を返す
    const invitation = await tx.invitations.consumeValidToken({ tokenHash, now });
    // 無効 / 失効 / 既使用ならここで中断 (どれも同じ案内にして詮索余地を減らす)
    if (!invitation) {
      throw new Error('この招待リンクは無効か、既に使用されています。');
    }

    // 作成に使うメールを決める: 招待にメールがあればそれを優先 (なりすまし防止)、無ければ入力値
    const finalEmail = invitation.email ?? inputEmail;
    // どちらも無ければメール必須エラー
    if (!finalEmail) {
      throw new Error('メールアドレスは必須です');
    }

    // 既存ユーザーとの重複を事前チェック (@unique 制約より親切な日本語エラーを返すため)
    const existing = await tx.users.findByEmail(finalEmail);
    if (existing) {
      throw new Error('このメールアドレスは既に登録されています。ログインしてください。');
    }

    // パスワードを bcrypt でハッシュ化 (cost 12。seed と同条件)
    const passwordHash = await hash(password, 12);
    // 招待行が指すテナント・権限でユーザーを作成する (tenantId は入力ではなく invitation 由来)
    await tx.users.create({
      email: finalEmail,
      name,
      passwordHash,
      role: invitation.role,
      tenantId: invitation.tenantId,
    });

    // クライアントがログインに使うメールを返す
    return { email: finalEmail };
  });

  // トランザクションの結果 (作成に使ったメール) を返す
  return result;
}

// 受諾ページが「このトークンが今この瞬間に有効か」を表示判定するための読み取り専用ヘルパー。
// 消費はしない (ページ表示で焼かないため)。期限切れ / 使用済み / 不在なら false を返す。
export async function isInvitationAcceptable(
  rawToken: string,
): Promise<{ acceptable: boolean; needsEmail: boolean }> {
  // 生トークンを DB 保存値と同じ SHA-256 ハッシュへ変換する
  const tokenHash = await hashInviteToken(rawToken);
  // tokenHash で招待を引く (読み取りのみ)
  const invitation = await repos.invitations.findByTokenHash(tokenHash);
  // 不在 / 使用済み / 失効はいずれも受諾不可
  if (!invitation || invitation.consumedAt !== null || invitation.expiresAt < new Date()) {
    return { acceptable: false, needsEmail: false };
  }
  // 招待にメールが無い場合は、受諾フォームでメール入力を求める必要がある
  return { acceptable: true, needsEmail: invitation.email === null };
}
