'use server';

// AI FAQ 自己解決 (起票前の FAQ 提案) の Server Action 群。docs/smb-dx-pivot-plan.md §4.29 / §6.1 Pro。
//
// 流れ: 依頼者が起票フォームに件名・内容を入力 → suggestFaqForDraft が公開済み FAQ から前段抽出
// (文字 bigram) → LLM 照合 → 検証済みの一致だけを提示 → 依頼者が「解決した」「問い合わせを続ける」を選ぶと
// recordDeflectionOutcome が決着を記録する。依頼者の入力本文は DB に保存しない (§9 最小公開)。
//
// Server Action にした理由: Route Handler だと同一オリジン検証・本文サイズ上限 (entry-body-limit) の
// 登録が別途必要になるが、Server Action は Next.js の組み込み Origin 検証で保護され、入力も
// 件名 200 文字 + 内容 10,000 文字で既定の本文上限に収まるため。

// データ層の Composition Root (Prisma 直叩きを避ける)
import { repos } from '@/data';
// 公開 FAQ 一覧の取得件数上限 (前段抽出の母集団。§8 一覧取得は必ず上限を持たせる)
import { FAQ_LIST_LIMIT } from '@/data/ports/faq-repository';
// 現在ログイン中のセッションを取得する next-auth ヘルパー
import { auth } from '@/lib/auth';
// レート制限 (LLM 呼び出しは有償なので連打を抑える)
import { enforceRateLimit, RateLimitError } from '@/lib/rate-limit';
// プランゲート (Pro / Enterprise のみ) とテナントの実効プラン解決
import { isAiDeflectionAllowed } from '@/lib/plan-guard';
import { resolveTenantPlan } from '@/lib/tenant-plan';
// LLM 照合クライアント (環境変数未設定なら null = 機能無効)
import { getDeflectionMatcher } from '@/lib/deflection-llm';
// 前段抽出と判定検証の純粋関数
import { rankFaqCandidates, validateMatcherVerdict } from '@/domain/deflection';
// 入力検証スキーマ
import { recordDeflectionOutcomeSchema, suggestFaqInputSchema } from '@/lib/validations/deflection';

// 依頼者に提示する FAQ 1 件 (画面表示に必要な最小限)
export interface SuggestedFaq {
  faqId: string; // FAQ ID
  question: string; // 質問文
  answer: string; // 回答文
  confidence: number; // LLM の確信度 (0〜1)
}

// suggestFaqForDraft の結果。unavailable は「機能が使えない/失敗した」で、画面は何も出さない
export type SuggestFaqResult =
  | { status: 'unavailable' } // プラン対象外・未構成・LLM 失敗・レート制限 (提案なしで起票を続行)
  | { status: 'none'; eventId: string } // 候補が無い/該当なし (no_match として記録済み)
  | { status: 'suggested'; eventId: string; matches: SuggestedFaq[] }; // 提示あり (suggested として記録済み)

// ユーザー単位のレート制限: 提案は 60 秒あたり 10 回まで (1 回ごとに LLM を呼ぶため厳しめ)
const SUGGEST_RATE_LIMIT = { limit: 10, windowMs: 60_000 } as const;
// 決着記録は 60 秒あたり 30 回まで (DB 更新 1 回だけなので提案より緩い)
const OUTCOME_RATE_LIMIT = { limit: 30, windowMs: 60_000 } as const;

// 起票フォームの下書き (件名・内容) に対して公開済み FAQ を提案するサーバーアクション。
// 依頼者・エージェントを問わずログイン済みメンバーなら呼べる (FAQ は公開済みのみを対象にする)
export async function suggestFaqForDraft(input: {
  title: string;
  body: string;
}): Promise<SuggestFaqResult> {
  // ログインセッションを取得
  const session = await auth();
  // 未ログイン or tenantId 不在なら即エラー (認可前チェック)
  if (!session?.user?.id || !session.user.tenantId) throw new Error('Unauthorized');
  // セッションから tenantId / userId を取り出して以降の where 句注入に使う
  const tenantId = session.user.tenantId;
  const userId = session.user.id;

  // 入力値 (件名/内容) を Zod で検証する (チケット作成と同じ規則)
  const parsed = suggestFaqInputSchema.safeParse(input);
  // 検証失敗なら提案を出さない (起票フォーム側の検証が先に弾くので通常ここには来ない)
  if (!parsed.success) return { status: 'unavailable' };

  // プランゲート: Pro / Enterprise 以外は提案を出さない (UI 非表示に頼らずサーバー側で強制。§9)
  const plan = await resolveTenantPlan(tenantId);
  if (!isAiDeflectionAllowed(plan)) return { status: 'unavailable' };

  // LLM クライアントを解決する (API キー未設定なら機能無効)
  const matcher = getDeflectionMatcher();
  if (!matcher) return { status: 'unavailable' };

  // レート制限 (超過時は提案を出さずに静かに縮退する。起票の妨げにしない)
  try {
    enforceRateLimit(`deflection-suggest:${userId}`, SUGGEST_RATE_LIMIT);
  } catch (err) {
    // レート制限超過は想定内の縮退なので unavailable を返す。それ以外は握り潰さず再送出する (§6)
    if (err instanceof RateLimitError) return { status: 'unavailable' };
    throw err;
  }

  // 公開済み FAQ をテナントスコープで取得する (上限付き)
  const published = await repos.faq.listPublished(tenantId, { limit: FAQ_LIST_LIMIT });
  // 件名と内容を連結して前段抽出にかける
  const query = `${parsed.data.title}\n${parsed.data.body}`;
  // 字面が近い上位候補を選ぶ (純粋関数)
  const candidates = rankFaqCandidates(query, published);

  // 候補が 1 件も無ければ LLM を呼ばずに no_match として記録して終了 (コスト削減)
  if (candidates.length === 0) {
    const event = await repos.deflectionEvents.create({
      tenantId,
      userId,
      outcome: 'no_match',
      candidateCount: 0,
      matchedFaqId: null,
      model: null, // LLM 未呼び出し
    });
    return { status: 'none', eventId: event.id };
  }

  // LLM に候補と入力を渡して照合する
  const result = await matcher.match({ query, candidates });
  // 呼び出し失敗はサーバーログに残し (本文・キーは含めない)、画面には何も出さない (fail-safe)
  if (!result.ok) {
    console.warn('[deflection] LLM 照合に失敗したため提案をスキップします', {
      tenantId,
      reason: result.reason,
    });
    return { status: 'unavailable' };
  }

  // LLM の判定を候補集合で検証する (候補外 ID = 幻覚を除外。確信度順に上位のみ)
  const candidateIds = new Set(candidates.map((c) => c.id));
  const validated = validateMatcherVerdict(result.verdicts, candidateIds);

  // 該当が無ければ no_match として記録して終了
  if (validated.length === 0) {
    const event = await repos.deflectionEvents.create({
      tenantId,
      userId,
      outcome: 'no_match',
      candidateCount: candidates.length,
      matchedFaqId: null,
      model: matcher.model,
    });
    return { status: 'none', eventId: event.id };
  }

  // 検証済みの一致に FAQ の本文を結合して提示用に整える (候補集合から引くので必ず見つかる)
  const byId = new Map(candidates.map((c) => [c.id, c] as const));
  const matches = validated.flatMap<SuggestedFaq>((m) => {
    // 候補集合から本文を引く (validateMatcherVerdict が候補内に限定済み)
    const faq = byId.get(m.faqId);
    // 万一見つからなければその 1 件だけ落とす (fail-safe)
    return faq
      ? [{ faqId: faq.id, question: faq.question, answer: faq.answer, confidence: m.confidence }]
      : [];
  });

  // 提示を suggested として記録する (最上位の FAQ ID を matchedFaqId に残す)
  const event = await repos.deflectionEvents.create({
    tenantId,
    userId,
    outcome: 'suggested',
    candidateCount: candidates.length,
    matchedFaqId: matches[0]?.faqId ?? null,
    model: matcher.model,
  });
  // 提示結果を返す
  return { status: 'suggested', eventId: event.id, matches };
}

// 提示した FAQ に対する依頼者の決着 (解決した / 問い合わせを続ける) を記録するサーバーアクション。
// 本人 (userId) の記録だけを、suggested からの遷移に限って更新する (CAS)。更新できなければ false
export async function recordDeflectionOutcome(input: {
  eventId: string;
  outcome: 'resolved' | 'proceeded';
  ticketId?: string;
}): Promise<{ ok: boolean }> {
  // ログインセッションを取得
  const session = await auth();
  // 未ログイン or tenantId 不在なら即エラー (認可前チェック)
  if (!session?.user?.id || !session.user.tenantId) throw new Error('Unauthorized');
  // セッションから tenantId / userId を取り出す
  const tenantId = session.user.tenantId;
  const userId = session.user.id;

  // 入力値を Zod で検証する
  const parsed = recordDeflectionOutcomeSchema.safeParse(input);
  // 検証失敗なら記録しない (画面上の補助機能なのでエラー表示はしない)
  if (!parsed.success) return { ok: false };

  // レート制限 (超過時は記録をスキップする。それ以外の例外は再送出)
  try {
    enforceRateLimit(`deflection-outcome:${userId}`, OUTCOME_RATE_LIMIT);
  } catch (err) {
    if (err instanceof RateLimitError) return { ok: false };
    throw err;
  }

  // 起票に進んだ場合のチケット ID は、自テナントに実在するものだけを紐づける (他テナント ID の混入防止)
  let ticketId: string | null = null;
  if (parsed.data.outcome === 'proceeded' && parsed.data.ticketId) {
    // テナントスコープでチケットを引く (port 経由)
    const ticket = await repos.tickets.findById(parsed.data.ticketId, tenantId);
    // 実在すれば紐づけ、無ければ null のまま (決着の記録自体は行う)
    ticketId = ticket ? ticket.id : null;
  }

  // suggested → resolved/proceeded の CAS 更新 (テナント + 本人スコープ)
  const ok = await repos.deflectionEvents.updateOutcome(
    parsed.data.eventId,
    { from: 'suggested', to: parsed.data.outcome },
    { tenantId, userId },
    ticketId,
  );
  // 更新できたかを返す
  return { ok };
}
