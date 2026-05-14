'use server';

// ページキャッシュを無効化するための Next.js 関数
import { revalidatePath } from 'next/cache';
// データ層の Composition Root (Prisma 直叩きを避ける)
import { repos } from '@/data';
// 現在ログイン中のセッションを取得する next-auth ヘルパー
import { auth } from '@/lib/auth';
// 「エージェント権限を持つか」を判定するヘルパー
import { isAgent } from '@/lib/role';
// FAQ 候補化を許可する状態 (Resolved のみ) の一覧
import { FAQ_ELIGIBLE_STATUSES } from '@/lib/constants';
// レート制限 (連打防止) の共通関数
import { enforceRateLimit } from '@/lib/rate-limit';
// FAQ 候補入力の Zod スキーマ (質問/回答の検証)
import { faqCandidateSchema } from '@/lib/validations/faq';

// チケットを元に FAQ 候補を新規作成するサーバーアクション
export async function createFaqCandidate(ticketId: string, question: string, answer: string) {
  // ログインセッションを取得
  const session = await auth();
  // 未ログイン or tenantId 不在なら即エラー (認可前チェック)
  if (!session?.user?.id || !session.user.tenantId) throw new Error('Unauthorized');
  // エージェント/管理者でなければ操作禁止
  if (!isAgent(session.user.role)) {
    throw new Error('エージェントまたは管理者のみ実行できます');
  }
  // セッションから tenantId を取り出して以降の where 句注入に使う
  const tenantId = session.user.tenantId;
  // ユーザー単位で 60 秒あたり最大 10 件までに制限 (連打防止)
  enforceRateLimit(`faq-create:${session.user.id}`, { limit: 10, windowMs: 60_000 });

  // 入力値 (質問/回答) を Zod で検証
  const parsed = faqCandidateSchema.safeParse({ question, answer });
  // 検証失敗ならメッセージを日本語エラーとして投げる
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'FAQ候補の入力値が不正です');
  }

  // 対象チケットを tenantId スコープで取得 (port 経由)
  const ticket = await repos.tickets.findById(ticketId, tenantId);
  // 無ければエラー
  if (!ticket) throw new Error('チケットが見つかりません');
  // 解決済み以外は FAQ 化不可
  if (!FAQ_ELIGIBLE_STATUSES.includes(ticket.status)) {
    throw new Error('解決済みチケットのみFAQ候補に変換できます');
  }

  // FAQ 候補を新規作成 (初期ステータスは Adapter 側の既定値 Candidate)
  await repos.faq.create({
    ticketId,
    createdById: session.user.id, // 作成者
    question: parsed.data.question, // 検証済みの質問文
    answer: parsed.data.answer, // 検証済みの回答文
    // 元チケットと同じテナントスコープで FAQ 候補を保存
    tenantId: ticket.tenantId,
  });

  // チケット詳細ページのキャッシュを無効化して再描画させる
  revalidatePath(`/tickets/${ticketId}`);
  // FAQ 一覧ページのキャッシュも無効化
  revalidatePath('/faq');
}

// FAQ 候補の状態を公開/却下に切り替えるサーバーアクション
export async function updateFaqStatus(faqId: string, status: 'Published' | 'Rejected') {
  // セッション取得
  const session = await auth();
  // 未ログイン or tenantId 不在なら拒否
  if (!session?.user?.id || !session.user.tenantId) throw new Error('Unauthorized');
  // エージェント/管理者以外は拒否
  if (!isAgent(session.user.role)) {
    throw new Error('エージェントまたは管理者のみ実行できます');
  }
  // セッションから tenantId を取り出して以降の where 句注入に使う
  const tenantId = session.user.tenantId;
  // 60 秒あたり 20 回までに制限
  enforceRateLimit(`faq-update:${session.user.id}`, { limit: 20, windowMs: 60_000 });

  // 対象 FAQ 候補を tenantId スコープで取得 (port 経由)
  const faq = await repos.faq.findById(faqId, tenantId);
  // 見つからない or 他テナントの ID ならエラー
  if (!faq) throw new Error('FAQ候補が見つかりません');
  // 既に公開/却下済みのものは対象外
  if (faq.status !== 'Candidate') {
    throw new Error('候補ステータスのFAQのみ公開・却下できます');
  }

  // 状態を更新 (tenantId スコープで where に注入、port 経由)
  await repos.faq.updateStatus(faqId, status, tenantId);
  // FAQ 一覧のキャッシュを無効化
  revalidatePath('/faq');
}
