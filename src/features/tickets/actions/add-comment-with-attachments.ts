'use server';

// ページキャッシュを無効化する Next.js の関数
import { revalidatePath } from 'next/cache';
// crypto ベースの UUID 生成 (保存先キー組み立て用)
import { randomUUID } from 'node:crypto';
// 現在のセッション (ログイン中ユーザー) を取得
import { auth } from '@/lib/auth';
// リポジトリ束 + UoW (トランザクション境界) + ストレージ Port
import { repos, storage, uow } from '@/data';
// 未読件数を SSE で即時配信するヘルパー
import { broadcastUnreadCountToMany } from '@/features/notifications/notify';
// エージェント権限判定 (agent または admin のとき true)
import { isAgent } from '@/lib/role';
// レート制限ヘルパー
import { enforceRateLimit } from '@/lib/rate-limit';
// コメント本文の Zod スキーマ
import { commentBodySchema } from '@/lib/validations/ticket';
// 添付ファイル検証ヘルパー
import { validateUploadedFiles } from '@/lib/validations/attachment';
// MIME → 拡張子の対応表 (storageKey の組み立てで使う)
import { MIME_TO_EXTENSION } from '@/domain/attachment';
// next-auth のセッション型
import type { Session } from 'next-auth';

// セッションがログイン済みであることを保証するアサーション関数
function assertAuthenticatedUser(session: Session | null): asserts session is Session {
  // ユーザー ID が無ければ未ログインとみなしてエラー
  if (!session?.user?.id) throw new Error('Unauthorized');
  // tenantId 不在は middleware で弾く想定だが、Server Action でも防御的にチェック
  if (!session.user.tenantId) throw new Error('Unauthorized');
}

// コメント本文 + 添付ファイル をまとめて投稿する Server Action。
// 既存の addComment と分けている理由: FormData (multipart) を受け取りたい一方で、
// 既存の addComment は (id, body) の単純シグネチャを保ったまま JSON 経由の呼び出しを温存したいため。
export async function addCommentWithAttachments(ticketId: string, formData: FormData) {
  // セッション取得
  const session = await auth();
  // 投稿はログイン済みなら依頼者でも可
  assertAuthenticatedUser(session);
  // テナントスコープ用に tenantId を取り出す
  const tenantId = session.user.tenantId;
  // 60 秒あたり 20 件までに制限 (既存 addComment と同じ閾値)
  enforceRateLimit(`ticket-comment:${session.user.id}`, { limit: 20, windowMs: 60_000 });

  // 本文を取り出して Zod で検証する (空送信や 5000 文字超過を弾く)
  const rawBody = (formData.get('body') ?? '') as string;
  const parsedBody = commentBodySchema.safeParse(rawBody);
  if (!parsedBody.success) {
    // 検証失敗時は最初の issue メッセージを日本語でそのまま投げる
    throw new Error(parsedBody.error.issues[0]?.message ?? 'コメントが不正です');
  }
  const trimmedBody = parsedBody.data;

  // 添付ファイルを抽出し、共通ヘルパーで件数 / MIME / サイズを検査する
  const files = formData.getAll('files').filter((e): e is File => e instanceof File);
  const attachmentValidation = validateUploadedFiles(files);
  if (!attachmentValidation.ok) {
    // 検証失敗時は日本語メッセージをそのまま throw する
    throw new Error(attachmentValidation.message);
  }

  // 対象チケットを tenantId スコープで取得
  const ticket = await repos.tickets.findById(ticketId, tenantId);
  if (!ticket) throw new Error('チケットが見つかりません');

  // 投稿者 ID とロールをまとめて抽出
  const authorId = session.user.id;
  const authorIsAgent = isAgent(session.user.role);
  // エージェント、または自分が作成したチケットならコメント可
  const canComment = authorIsAgent || ticket.creatorId === authorId;
  if (!canComment) {
    throw new Error('このチケットへのコメント権限がありません');
  }

  // 通知の送信先を決定する (既存 addComment のロジックを踏襲)
  const recipientIds = await resolveCommentRecipients(ticket, authorId, authorIsAgent, tenantId);
  // 通知メッセージ (タイトル入り)
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
      });

      // 添付ファイルがあれば 1 件ずつ「ストレージ書き込み → メタ INSERT」の順に処理する
      for (const v of attachmentValidation.files) {
        // 保存先キーを組み立てる (例: tenantId/ticketId/<uuid>.jpg)
        const ext = MIME_TO_EXTENSION[v.mimeType];
        const key = `${tenantId}/${ticket.id}/${randomUUID()}.${ext}`;
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
          console.warn('[addCommentWithAttachments] failed to clean up storage', {
            key,
            cleanupErr,
          });
        }),
      ),
    );
    // 元のエラーを呼び出し元に再 throw (UI 側で文言を表示)
    throw err;
  }

  // 通知対象が 1 名以上いれば未読件数を一斉配信
  if (recipientIds.length > 0) await broadcastUnreadCountToMany(recipientIds, tenantId);
  // 詳細ページのキャッシュを無効化して再描画させる
  revalidatePath(`/tickets/${ticketId}`);
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
