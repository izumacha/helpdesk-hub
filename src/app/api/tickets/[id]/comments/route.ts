// JSON / 201 レスポンスを返すヘルパー
import { NextResponse } from 'next/server';
// crypto ベースの UUID 生成 (保存先キー組み立て用)
import { randomUUID } from 'node:crypto';
// ページキャッシュを無効化する Next.js の関数
import { revalidatePath } from 'next/cache';
// セッション取得
import { auth } from '@/lib/auth';
// リポジトリ束 + UoW (トランザクション境界)
import { repos, uow } from '@/data';
// 添付ファイル本体の StoragePort (Edge runtime 汚染回避のため別モジュールから取り込む)
import { storage } from '@/data/storage';
// 未読件数を SSE で即時配信するヘルパー
import { broadcastUnreadCountToMany } from '@/features/notifications/notify';
// エージェント権限判定 (agent または admin のとき true)
import { isAgent } from '@/lib/role';
// レート制限ヘルパー (超過時は RateLimitError を throw)
import { enforceRateLimit, RateLimitError } from '@/lib/rate-limit';
// コメント本文の Zod スキーマ
import { commentBodySchema } from '@/lib/validations/ticket';
// 添付ファイル検証ヘルパー
import { validateUploadedFiles } from '@/lib/validations/attachment';
// MIME → 拡張子の対応表 (storageKey の組み立てで使う)
import { MIME_TO_EXTENSION } from '@/domain/attachment';

// /api/tickets/[id]/comments の動的セグメント
type Params = { params: Promise<{ id: string }> };

// 422 (バリデーションエラー) を共通フォーマットで返すヘルパー
function validationError(message: string, path: (string | number)[]) {
  // Zod 互換の issues 形状で 422 レスポンスを返す (フォーム側が読みやすいよう整形)
  return NextResponse.json(
    {
      error: '入力値が正しくありません',
      issues: [{ code: 'custom', path, message }],
    },
    { status: 422 },
  );
}

// POST /api/tickets/[id]/comments : コメント (任意で添付画像) を投稿する Route Handler。
// Server Action の既定 1MB ボディ上限を回避するためエンドポイントを切り分けている (Phase 1)。
// multipart/form-data を受け取り、本文と files[] をまとめて 1 トランザクションで処理する。
export async function POST(req: Request, { params }: Params) {
  // セッション取得
  const session = await auth();
  // 未ログインなら 401
  if (!session?.user?.id) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 });
  }
  // セッションから tenantId / 投稿者を取り出す
  const tenantId = session.user.tenantId;
  const authorId = session.user.id;
  const authorIsAgent = isAgent(session.user.role);

  // チケット ID を動的セグメントから取り出す
  const { id: ticketId } = await params;

  // 60 秒あたり 20 件までに制限 (既存 addComment と同じ閾値)
  // 超過は RateLimitError として投げられるので、HTTP 429 + Retry-After にマップする
  // (500 にしてしまうとクライアントが「再試行可能な制限」と「サーバ障害」を区別できない)
  try {
    enforceRateLimit(`ticket-comment:${authorId}`, { limit: 20, windowMs: 60_000 });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return NextResponse.json(
        { error: err.message },
        { status: 429, headers: { 'Retry-After': String(err.retryAfterSec) } },
      );
    }
    // 想定外のエラーはそのまま再 throw (Next.js が 500 にする)
    throw err;
  }

  // FormData として読み出す (multipart/form-data 専用)
  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    // FormData のパースに失敗した場合はログに残してから 400 を返す
    console.error('[POST /api/tickets/[id]/comments] FormData のパースに失敗しました', err);
    return NextResponse.json({ error: 'リクエストの形式が正しくありません' }, { status: 400 });
  }

  // 本文を Zod で検証 (前後空白トリム、1〜5000 文字)
  const rawBody = (form.get('body') ?? '') as string;
  const parsedBody = commentBodySchema.safeParse(rawBody);
  if (!parsedBody.success) {
    // 検証失敗時は最初の issue メッセージで 422 を返す
    return validationError(parsedBody.error.issues[0]?.message ?? 'コメントが不正です', ['body']);
  }
  const trimmedBody = parsedBody.data;

  // 添付ファイルを抽出して件数 / MIME / サイズ / マジックバイトを検証する
  const files = form.getAll('files').filter((e): e is File => e instanceof File);
  const attachmentValidation = await validateUploadedFiles(files);
  if (!attachmentValidation.ok) {
    return validationError(attachmentValidation.message, ['files']);
  }

  // 対象チケットを tenantId スコープで取得 (他テナントは null になる)
  const ticket = await repos.tickets.findById(ticketId, tenantId);
  if (!ticket) {
    return NextResponse.json({ error: 'チケットが見つかりません' }, { status: 404 });
  }
  // エージェント、または自分が作成したチケットならコメント可
  if (!authorIsAgent && ticket.creatorId !== authorId) {
    // 存在を隠すため 404 で揃える (RBAC で 403 を返すと添付の有無が漏れる)
    return NextResponse.json({ error: 'チケットが見つかりません' }, { status: 404 });
  }

  // 通知の送信先を決定する (既存 addComment と同じロジック)
  const recipientIds = await resolveCommentRecipients(ticket, authorId, authorIsAgent, tenantId);
  const message = `チケット「${ticket.title}」に新しいコメントが追加されました`;

  // ストレージへ書き込んだキーをロールバック用に蓄える
  const writtenKeys: string[] = [];
  try {
    // コメント保存 + 添付保存 + 通知作成を 1 トランザクションで実行する
    await uow.run(async (r) => {
      // コメント本体を保存し、後段で commentId として参照する
      const comment = await r.comments.create({
        ticketId,
        authorId,
        body: trimmedBody,
        tenantId, // 親チケットのテナント一致を Adapter 側でも検証する (issue #123)
      });

      // 添付ファイルがあれば 1 件ずつ「ストレージ書き込み → メタ INSERT」の順に処理する
      for (const v of attachmentValidation.files) {
        // 保存先キーを組み立てる (例: tenantId/ticketId/<uuid>.jpg)
        const ext = MIME_TO_EXTENSION[v.mimeType];
        const key = `${tenantId}/${ticketId}/${randomUUID()}.${ext}`;
        // File 本体のバイト列を ArrayBuffer 経由で Uint8Array に変換する
        const buf = new Uint8Array(await v.file.arrayBuffer());
        // ストレージへ書き込む (失敗時は uow がロールバック + 後段で削除)
        await storage.put(key, buf, { contentType: v.mimeType, size: v.size });
        writtenKeys.push(key);
        // メタ情報を DB に保存 (commentId をセットしてコメント添付として記録)
        await r.attachments.create({
          ticketId,
          commentId: comment.id,
          uploaderId: authorId,
          tenantId,
          mimeType: v.mimeType,
          size: v.size,
          originalName: v.originalName,
          storageKey: key,
          storage: 'local',
        });
      }

      // 通知対象に「コメントが追加された」旨を一斉送付する
      await Promise.all(
        recipientIds.map((id) =>
          r.notifications.create({
            userId: id,
            type: 'commented',
            message,
            ticketId,
            tenantId: ticket.tenantId,
          }),
        ),
      );
    });
  } catch (err) {
    // DB は自動ロールバック済。ストレージに書き込んだファイルを best-effort で削除する
    await Promise.all(
      writtenKeys.map((key) =>
        storage.delete(key).catch((cleanupErr) => {
          console.warn('[POST /api/tickets/[id]/comments] failed to clean up storage', {
            key,
            cleanupErr,
          });
        }),
      ),
    );
    // 元のエラーをサーバログに残して 500 を返す
    console.error('[POST /api/tickets/[id]/comments] save failed', err);
    return NextResponse.json({ error: 'コメントの保存に失敗しました' }, { status: 500 });
  }

  // 通知対象が 1 名以上いれば未読件数を一斉配信
  if (recipientIds.length > 0) await broadcastUnreadCountToMany(recipientIds, tenantId);
  // 詳細ページのキャッシュを無効化して再描画させる
  revalidatePath(`/tickets/${ticketId}`);

  // 成功は 201 で空ボディ相当に近い JSON を返す (フロントは画面遷移しない)
  return NextResponse.json({ ok: true }, { status: 201 });
}

// コメント通知の送信先を決定する内部ヘルパー (既存 addComment と同じロジック)
async function resolveCommentRecipients(
  ticket: { creatorId: string; assigneeId: string | null },
  authorId: string,
  authorIsAgent: boolean,
  tenantId: string,
): Promise<string[]> {
  // 宛先候補を集める配列
  const candidates: string[] = [];
  // エージェントがコメントした場合: 依頼者 (+ 担当者が居れば担当者)
  if (authorIsAgent) {
    candidates.push(ticket.creatorId);
    if (ticket.assigneeId) candidates.push(ticket.assigneeId);
  } else if (ticket.assigneeId) {
    // 依頼者がコメントし担当者が決まっている場合は担当者のみ
    candidates.push(ticket.assigneeId);
  } else {
    // 依頼者がコメントし担当者未定なら全エージェントに通知 (テナント内のみ)
    candidates.push(...(await repos.users.listAgentIds(tenantId)));
  }
  // 重複排除し、コメント投稿者自身は除外して返す
  return Array.from(new Set(candidates)).filter((id) => id !== authorId);
}
