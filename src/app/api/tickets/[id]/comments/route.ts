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
// 環境変数で切り替わる EmailSender 実装を取得するファクトリ (依頼者宛メール送信用)
import { getEmailSender } from '@/lib/email';
// メール内リンクのベース URL を解決する共通ヘルパー
import { resolveAppBaseUrl } from '@/lib/app-url';
// 依頼者宛「返信が届きました」メールの URL 構築 / 本文組み立て (純粋ヘルパー)
import { buildTicketUrl, renderTicketReplyEmail } from '@/lib/ticket-email';
// 返信メールに付与する決定的 Message-ID の生成 (スレッド継続の起点)
import { buildReplyMessageId, resolveMessageIdDomain } from '@/lib/email-message-id';
// エージェント権限判定 (agent または admin のとき true)
import { isAgent } from '@/lib/role';
// コメント通知の宛先決定 (メール取り込みのスレッド継続と共有するヘルパー)
import { resolveCommentRecipients } from '@/lib/comment-recipients';
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
  // 未ログイン、または tenantId が取得できない場合は 401 (tenantId が null だと後続の where 句注入が機能しないため)
  if (!session?.user?.id || !session.user.tenantId) {
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

  // Phase 2「対応すると依頼者にメールで返信が届く」(docs/smb-dx-pivot-plan.md §4 Phase 2):
  // 担当者がコメント (返信) した場合は、依頼者がアプリにログインしなくても内容を確認できるよう
  // 依頼者宛にメールを送る。コメント保存はコミット済みなので、メール送信はベストエフォートとし
  // 失敗してもレスポンスは 201 のままにする (アプリ内通知 / SSE は既に成立している)。
  if (authorIsAgent) {
    await sendReplyEmailToRequester({
      ticket,
      authorId,
      authorName: session.user.name ?? '担当者',
      commentBody: trimmedBody,
      ticketId,
      tenantId,
    });
  }

  // 詳細ページのキャッシュを無効化して再描画させる
  revalidatePath(`/tickets/${ticketId}`);

  // 成功は 201 で空ボディ相当に近い JSON を返す (フロントは画面遷移しない)
  return NextResponse.json({ ok: true }, { status: 201 });
}

// 担当者の返信を依頼者へメールで届ける内部ヘルパー (ベストエフォート / 副作用は send のみ)。
// 例外は呼び出し側に伝播させず、ログに残して握り潰す: メール送信の失敗で「コメントは保存できたのに
// 500 が返る」事態 (= フロントが二重投稿しかねない) を避けるため。
async function sendReplyEmailToRequester(args: {
  ticket: { creatorId: string; title: string };
  authorId: string;
  authorName: string;
  commentBody: string;
  ticketId: string;
  tenantId: string;
}): Promise<void> {
  const { ticket, authorId, authorName, commentBody, ticketId, tenantId } = args;
  // 自分が起票したチケットに自分で返信した場合は自分宛メールを送らない
  if (ticket.creatorId === authorId) return;

  try {
    // 依頼者 (起票者) のメールアドレスを引く (認証用なのでテナント横断 lookup)
    const creator = await repos.users.findById(ticket.creatorId);
    // 依頼者が見つからない / メール未設定なら送りようがないのでスキップ
    if (!creator?.email) return;

    // メール内リンクのベース URL を解決 (production で NEXTAUTH_URL 未設定なら throw → 下で握る)
    const baseUrl = resolveAppBaseUrl();
    // チケット詳細ページへの導線 URL を組み立てる
    const ticketUrl = buildTicketUrl(baseUrl, ticketId);
    // 件名 / 本文 (Text / HTML) を純粋ヘルパーで構築
    const { subject, text, html } = renderTicketReplyEmail({
      ticketTitle: ticket.title,
      ticketUrl,
      commentBody,
      agentName: authorName,
    });
    // Phase 2 スレッド継続: 返信メールに決定的 Message-ID を付与する。依頼者がこのメールに
    // 返信すると In-Reply-To にこの値が載るので、受信 Webhook 側で元チケットへ紐付けられる。
    const replyMessageId = buildReplyMessageId(ticketId, resolveMessageIdDomain());
    // Message-ID → チケットの対応を先に登録する (送信前でも害は無く、登録漏れを避けられる)。
    // register は冪等なので再送・重複でも安全。
    await repos.emailThreads.register({
      messageId: replyMessageId.normalized, // 山括弧なしの正規化値 (受信側の表記と一致)
      ticketId, // この返信が属するチケット
      tenantId, // 所属テナント (突き合わせスコープ)
    });
    // 設定された EmailSender (console / smtp) 経由で送信 (Message-ID ヘッダ付き)
    await getEmailSender().send({
      to: creator.email,
      subject,
      text,
      html,
      messageId: replyMessageId.header,
    });
  } catch (err) {
    // 送信失敗はサーバログに残すだけ (依頼者への通知はアプリ内にも残っている)
    console.error('[POST /api/tickets/[id]/comments] 依頼者宛メール送信に失敗しました', err);
  }
}
