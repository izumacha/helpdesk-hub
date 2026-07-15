'use server';

// ページキャッシュを無効化するための Next.js 関数
import { revalidatePath } from 'next/cache';
// データ層の Composition Root (Prisma 直叩きを避ける)
import { repos } from '@/data';
// 現在ログイン中のセッションを取得する next-auth ヘルパー
import { auth } from '@/lib/auth';
// 「エージェント権限を持つか」を判定するヘルパー
import { isAgent } from '@/lib/role';
// 「完了」とみなすステータス集合を mode (lite/pro) に応じて返す関数 (唯一の源。update-ticket.ts と共有)
import { getCompletionStatuses } from '@/domain/ticket-status';
// FAQ 状態遷移の許可判定 (唯一の源。Server Action と UI の両方から参照する)
import { isValidFaqTransition } from '@/domain/faq-status';
// 「FAQ 候補」機能自体の呼称を mode に応じて切り替える定数 (エラーメッセージも Lite では
// 「よくある質問」と呼ぶ。§6 一元管理)
import { FAQ_TERM_LABELS } from '@/lib/constants';
// テナントの動作モード (lite | pro) を取得するヘルパー
import { getCurrentTenantMode } from '@/lib/tenant';
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
  // テナントの動作モード (lite | pro) を取得する。完了扱いの状態集合の判定だけでなく、
  // 以降のエラーメッセージの呼称 (Lite:「よくある質問」/ Pro:「FAQ候補」) にも使うため、
  // 早い段階で 1 度だけ取得しておく (§1.1 フォローアップ)
  const mode = await getCurrentTenantMode(tenantId);
  // この機能の呼称 (エラーメッセージも画面表示と揃える)
  const termLabel = FAQ_TERM_LABELS[mode];
  // ユーザー単位で 60 秒あたり最大 10 件までに制限 (連打防止)
  enforceRateLimit(`faq-create:${session.user.id}`, { limit: 10, windowMs: 60_000 });

  // 入力値 (質問/回答) を Zod で検証
  const parsed = faqCandidateSchema.safeParse({ question, answer });
  // 検証失敗ならメッセージを日本語エラーとして投げる
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? `${termLabel}の入力値が不正です`);
  }

  // 対象チケットを tenantId スコープで取得 (port 経由)
  const ticket = await repos.tickets.findById(ticketId, tenantId);
  // 無ければエラー
  if (!ticket) throw new Error('チケットが見つかりません');
  // 完了扱いの状態でなければ FAQ 化不可
  if (!getCompletionStatuses(mode).includes(ticket.status)) {
    throw new Error(`完了済みチケットのみ${termLabel}に変換できます`);
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
  // この機能の呼称 (エラーメッセージも画面表示と揃える)
  const termLabel = FAQ_TERM_LABELS[await getCurrentTenantMode(tenantId)];
  // 60 秒あたり 20 回までに制限
  enforceRateLimit(`faq-update:${session.user.id}`, { limit: 20, windowMs: 60_000 });

  // 対象 FAQ 候補を tenantId スコープで取得 (port 経由)
  const faq = await repos.faq.findById(faqId, tenantId);
  // 見つからない or 他テナントの ID ならエラー
  if (!faq) throw new Error(`${termLabel}が見つかりません`);
  // 遷移可否をドメイン層の遷移表 (唯一の源) で判定する。ticket-status.ts の
  // ALLOWED_TRANSITIONS と同じパターン (フォローアップ 2026-07-14 #6)
  if (!isValidFaqTransition(faq.status, status)) {
    throw new Error(`候補または公開済みの${termLabel}のみ状態を変更できます`);
  }

  // 状態を更新 (tenantId スコープで where に注入、port 経由)。読み取り時の状態 (faq.status) を
  // 期待値として渡し、直前に別の操作が状態を変えていた場合は 0 件更新 (false) になる
  // (check-then-act 競合で禁止遷移が後勝ちするのを防ぐ。フォローアップ 2026-07-15)
  const updated = await repos.faq.updateStatus(faqId, { from: faq.status, to: status }, tenantId);
  // 競合 (または削除) で更新できなかった場合は、画面の再読み込みを促すエラーを返す
  if (!updated) {
    throw new Error(
      `他の操作と競合したため変更できませんでした。最新の${termLabel}をご確認ください`,
    );
  }
  // FAQ 一覧のキャッシュを無効化
  revalidatePath('/faq');
}

// FAQ 候補の質問/回答本文を編集するサーバーアクション
// (フォローアップ 2026-07-14 #6: 公開済み FAQ を編集・訂正する手段が一つも無く、業種テンプレの
// 自動投入や誤操作による誤った内容が訂正不能なまま全依頼者に見え続けるギャップへの対応)
export async function updateFaqContent(faqId: string, question: string, answer: string) {
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
  // この機能の呼称 (エラーメッセージも画面表示と揃える)
  const termLabel = FAQ_TERM_LABELS[await getCurrentTenantMode(tenantId)];
  // 60 秒あたり 20 回までに制限 (updateFaqStatus と同じ上限)
  enforceRateLimit(`faq-update:${session.user.id}`, { limit: 20, windowMs: 60_000 });

  // 入力値 (質問/回答) を Zod で検証 (createFaqCandidate と同じスキーマを再利用)
  const parsed = faqCandidateSchema.safeParse({ question, answer });
  // 検証失敗ならメッセージを日本語エラーとして投げる
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? `${termLabel}の入力値が不正です`);
  }

  // 対象 FAQ 候補を tenantId スコープで取得 (port 経由。存在確認を兼ねる)
  const faq = await repos.faq.findById(faqId, tenantId);
  // 見つからない or 他テナントの ID ならエラー
  if (!faq) throw new Error(`${termLabel}が見つかりません`);

  // 質問/回答を更新 (tenantId スコープで where に注入、port 経由)
  await repos.faq.updateContent(
    faqId,
    { question: parsed.data.question, answer: parsed.data.answer },
    tenantId,
  );
  // FAQ 一覧のキャッシュを無効化
  revalidatePath('/faq');
}
