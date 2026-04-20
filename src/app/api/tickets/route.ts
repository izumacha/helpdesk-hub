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
  const { title, body: ticketBody, priority, categoryId } = parsed.data;

  // カテゴリ指定がある場合は存在確認
  if (categoryId) {
    // カテゴリを取得
    const category = await repos.categories.findById(categoryId);
    // 存在しなければ 422 (Zod 風の issues を返す)
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
  // リポジトリ経由でチケットを作成
  const ticket = await repos.tickets.create({
    title,
    body: ticketBody,
    priority,
    categoryId: categoryId ?? null,
    // 作成者は現在のログインユーザー
    creatorId: session.user.id,
    // 優先度に応じた解決期限を計算
    resolutionDueAt: calculateResolutionDueAt(priority, now),
  });

  // 作成された行を 201 で返す
  return NextResponse.json(ticket, { status: 201 });
}
