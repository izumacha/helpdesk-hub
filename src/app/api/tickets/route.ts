// JSON レスポンスを返すヘルパー
import { NextResponse } from 'next/server';
// セッション取得
import { auth } from '@/lib/auth';
// リポジトリ束 (tickets/categories などを持つ)
import { repos } from '@/data';
// 優先度から解決期限を計算する SLA ヘルパー
import { calculateResolutionDueAt } from '@/lib/sla';
// 新規チケット入力の Zod スキーマ
import { createTicketSchema } from '@/lib/validations/ticket';
// テナントの動作モード (lite | pro) を取得するヘルパー
import { getCurrentTenantMode } from '@/lib/tenant';

// POST /api/tickets : 新規チケットを作成する HTTP エンドポイント
export async function POST(req: Request) {
  // セッション取得
  const session = await auth();
  // 未ログインなら 401 を返す
  if (!session?.user?.id) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 });
  }

  // リクエストボディ格納用
  let body: unknown;
  try {
    // JSON としてパース
    body = await req.json();
  } catch {
    // 不正な JSON は 400 で弾く
    return NextResponse.json({ error: 'リクエストの形式が正しくありません' }, { status: 400 });
  }

  // Zod で入力値を検証
  const parsed = createTicketSchema.safeParse(body);
  // 検証失敗時は 422 + issues でフォーム側にエラーを返す
  if (!parsed.success) {
    return NextResponse.json(
      { error: '入力値が正しくありません', issues: parsed.error.issues },
      { status: 422 },
    );
  }

  // 検証済みの値を分解 (body は変数名衝突を避けてリネーム)
  const { title, body: ticketBody, priority, categoryId, dueDate } = parsed.data;

  // テナントの動作モードを取得し、Lite モード時の入力強制ルールを適用する
  const mode = await getCurrentTenantMode(session.user.tenantId);
  // Lite モードでは優先度を UI から選ばせず Medium 固定とする (Pivot plan §3.1)
  // - Lite フォームは「件名 / 内容 / 期限日」のみで priority フィールドを描画しないため、
  //   API 単体で叩かれた場合の防御として既定値に強制する
  const effectivePriority = mode === 'lite' ? 'Medium' : priority;
  // Lite モードではカテゴリも非表示。UI から送られないが、外部から送られた値は無視する
  const effectiveCategoryId = mode === 'lite' ? undefined : categoryId;

  // カテゴリ指定がある場合は存在確認 (現在のテナント内のカテゴリのみ許可)
  if (effectiveCategoryId) {
    // テナントスコープでカテゴリを取得 (他テナントの ID は null になる)
    const category = await repos.categories.findById(effectiveCategoryId, session.user.tenantId);
    // 存在しない、または他テナントなら 422 (Zod 風の issues を返す)
    if (!category) {
      return NextResponse.json(
        {
          error: '入力値が正しくありません',
          issues: [
            {
              code: 'custom',
              path: ['categoryId'],
              message: '指定されたカテゴリが存在しません',
            },
          ],
        },
        { status: 422 },
      );
    }
  }

  // 作成時刻 (SLA 期限の計算基準)
  const now = new Date();
  // 解決期限の決定:
  // - dueDate が指定されていれば、その日付の終端 (23:59:59.999) を resolutionDueAt とする
  //   (Lite モードでユーザーが「今日まで」と入れたら当日中いっぱい OK の意図に合わせる)
  // - 指定が無ければ従来どおり priority ベースで自動計算
  const resolutionDueAt = dueDate
    ? new Date(`${dueDate}T23:59:59.999`)
    : calculateResolutionDueAt(effectivePriority, now);

  // リポジトリ経由でチケットを作成
  const ticket = await repos.tickets.create({
    title,
    body: ticketBody,
    priority: effectivePriority,
    categoryId: effectiveCategoryId ?? null,
    // 作成者は現在のログインユーザー
    creatorId: session.user.id,
    // 起票元のテナント (マルチテナント化のキー)
    tenantId: session.user.tenantId,
    // 上で決定した解決期限 (ユーザー指定 or 自動計算)
    resolutionDueAt,
  });

  // 作成された行を 201 で返す
  return NextResponse.json(ticket, { status: 201 });
}
