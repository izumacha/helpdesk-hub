'use server';

/**
 * LINE 連携のメンバー起点アクション (Phase 2 β 解消 / docs/smb-dx-pivot-plan.md §4 Phase 2)。
 *
 * - generateLineLinkCode: ログイン中メンバーが自分用のワンタイムコードを 1 つ発行する。生コードは
 *   戻り値で 1 度だけ返し、DB には SHA-256 ハッシュのみ保存する。メンバーはこのコードを LINE 公式
 *   アカウントに送信し、Webhook 側 (/api/inbound/line) が照合して送信元 LINE ユーザー ID を紐付ける。
 * - unlinkLineAccount: ログイン中メンバーが自分の LINE 連携を解除する。
 *
 * セキュリティ要点:
 *  - 操作対象は常にセッション由来の自分 (session.user.id) と自テナント (session.user.tenantId) のみ。
 *    リクエスト入力からユーザー ID / テナント ID を受け取らない (他人の連携を書き換えさせない)。
 *  - admin 限定ではなく「ログイン済みなら誰でも自分の LINE を連携できる」自己サービス。
 *  - 連打・総当たり対策にユーザー単位のレート制限を掛ける。
 */

// データ層の Composition Root (Prisma 直叩きを避ける入口)
import { repos } from '@/data';
// 現在のセッション (ログイン中ユーザー) を取得
import { auth } from '@/lib/auth';
// ページキャッシュ無効化 (連携状態の表示を更新する)
import { revalidatePath } from 'next/cache';
// 公開操作の連打・総当たり防止 (§9)
import { enforceRateLimit, RateLimitError } from '@/lib/rate-limit';
// 紐付けコードの生成・ハッシュ化・有効期限
import {
  generateLineLinkCode,
  hashLineLinkCode,
  normalizeLineLinkCode,
  LINE_LINK_CODE_TTL_MS,
} from '@/lib/line-link';
// next-auth のセッション型
import type { Session } from 'next-auth';

// 解除操作のレート制限ウィンドウ (ミリ秒)。コード TTL (LINE_LINK_CODE_TTL_MS) とは独立した定数にすることで、
// TTL の変更が解除操作のレート制限ウィンドウに意図せず波及しないようにする (コード有効期限とは別概念)。
const UNLINK_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 分

// ログイン済み (ユーザー ID + tenantId を持つ) ことを保証するアサーション。
// LINE 連携は admin 限定ではなく自己サービスのため、ロールは問わず認証のみを要求する。
function assertAuthenticated(session: Session | null): asserts session is Session {
  // ユーザー ID が無ければ未ログイン
  if (!session?.user?.id) throw new Error('ログインが必要です');
  // tenantId 不在は middleware で弾く想定だが、Server Action でも防御的にチェック
  if (!session.user.tenantId) throw new Error('ログインが必要です');
}

// generateLineLinkCode の戻り値型 (発行した生コードと失効までの分数を返す)
export interface GenerateLineLinkCodeResult {
  code: string; // 表示用の生コード (例: "AB7K-9QF2")。この値は発行直後の 1 度だけ表示する
  expiresInMinutes: number; // 失効までの分数 (画面の案内表示用)
}

// 自分用の LINE 連携ワンタイムコードを 1 つ発行する
export async function generateLineLinkCode_action(): Promise<GenerateLineLinkCodeResult> {
  // セッション取得
  const session = await auth();
  // ログイン必須 (自分自身に対してのみ操作する)
  assertAuthenticated(session);
  // 操作対象は常にセッション由来の自分・自テナントのみ
  const userId = session.user.id;
  const tenantId = session.user.tenantId;

  // ユーザー単位のレート制限 (10 分に 5 回まで)。連打・総当たり的なコード再発行を抑止する
  try {
    enforceRateLimit(`line-link-code:${userId}`, { limit: 5, windowMs: LINE_LINK_CODE_TTL_MS });
  } catch (err) {
    // 流量超過専用エラーだけをユーザー向けメッセージに変換し、それ以外は上位へ送出する
    if (err instanceof RateLimitError) {
      throw new Error('コードの発行が多すぎます。しばらく待ってから再度お試しください。');
    }
    throw err;
  }

  // 生コードを生成し、DB にはハッシュのみ保存する (生は戻り値でのみ返す)
  const code = generateLineLinkCode();
  // 保存・照合は Webhook 側と同じ normalizeLineLinkCode (ハイフン除去 + 大文字化) で正規化してからハッシュ化する
  const codeHash = await hashLineLinkCode(normalizeLineLinkCode(code));
  // 失効時刻 (現在時刻 + TTL)
  const expiresAt = new Date(Date.now() + LINE_LINK_CODE_TTL_MS);
  // 自分のユーザー行にコードのハッシュと失効時刻を保存する (tenantId スコープ付き)
  await repos.users.setLineLinkCode(userId, tenantId, { codeHash, expiresAt });

  // 連携状態カードの再描画 (発行済み表示へ更新)
  revalidatePath('/settings/line');
  // 生コードと失効分数を返す (画面で 1 度だけ表示)
  return { code, expiresInMinutes: Math.floor(LINE_LINK_CODE_TTL_MS / 60_000) };
}

// 自分の LINE 連携を解除する
export async function unlinkLineAccount_action(): Promise<void> {
  // セッション取得
  const session = await auth();
  // ログイン必須
  assertAuthenticated(session);
  // 操作対象は常にセッション由来の自分・自テナントのみ
  const userId = session.user.id;
  const tenantId = session.user.tenantId;

  // 解除操作も連打による無意味な DB 書き込みを防ぐためレート制限をかける (§9 DoS 対策)。
  // コード発行より緩めの 10 回 / 10 分 (正規ユーザーの誤クリック程度は許容する)。
  // windowMs には LINE_LINK_CODE_TTL_MS でなく専用定数 UNLINK_RATE_LIMIT_WINDOW_MS を使う
  // (コード TTL と解除レート制限ウィンドウは別概念。一方の変更が他方に影響しないよう分離する)
  try {
    // ユーザー単位のバケットでカウントし、超過なら RateLimitError を投げる
    enforceRateLimit(`line-unlink:${userId}`, { limit: 10, windowMs: UNLINK_RATE_LIMIT_WINDOW_MS });
  } catch (err) {
    // 流量超過専用エラーだけをユーザー向けメッセージに変換し、それ以外は上位へ送出する
    if (err instanceof RateLimitError) {
      // ユーザー向けの日本語エラーメッセージを返す (内部詳細は含めない §9)
      throw new Error('解除操作が多すぎます。しばらく待ってから再度お試しください。');
    }
    // RateLimitError 以外の予期しないエラーはそのまま上位へ送出する
    throw err;
  }

  // 自分の lineUserId と発行中コードをまとめてクリアする (tenantId スコープ付き)
  await repos.users.unlinkLineUser(userId, tenantId);
  // 連携状態カードの再描画 (未連携表示へ更新)
  revalidatePath('/settings/line');
}
