// JSON / 201 レスポンスを返すヘルパー
import { NextResponse } from 'next/server';
// ページキャッシュを無効化する Next.js の関数
import { revalidatePath } from 'next/cache';
// セッション取得
import { auth } from '@/lib/auth';
// リポジトリ束 + UoW (トランザクション境界)
import { repos, uow } from '@/data';
// 未読件数を SSE で即時配信するヘルパー
import { broadcastUnreadCountToMany } from '@/features/notifications/notify';
// 環境変数で切り替わる EmailSender 実装を取得するファクトリ (依頼者宛メール送信用)
import { getEmailSender } from '@/lib/email';
// メール内リンクのベース URL を解決する共通ヘルパー
import { resolveAppBaseUrl } from '@/lib/app-url';
// 依頼者宛「返信が届きました」メールの URL 構築 / 本文組み立て (純粋ヘルパー)
import { buildTicketUrl, renderTicketReplyEmail } from '@/lib/ticket-email';
// 依頼者宛「返信が届きました」LINE push の本文組み立て / 送信 (Phase 2 アウトバウンド LINE 返信)、
// および「テナントで LINE push が使えるか (連携設定 + プランゲート)」を解決する共通ヘルパー
import {
  buildTicketReplyLineMessage,
  pushLineMessage,
  resolveLineAccessToken,
} from '@/lib/line-push';
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
// 添付ファイルのストレージ保存 / 失敗時クリーンアップの共通ヘルパー (POST /api/tickets・
// POST /api/inbound/email と共有。/code-review ultra 指摘対応: 3 箇所目の重複を解消)
// checkTicketAttachmentQuota はチケット当たりの添付総数上限チェック (監査で発見したギャップ対応)
import {
  persistAttachments,
  cleanupWrittenAttachments,
  checkTicketAttachmentQuota,
} from '@/lib/attachment-persistence';
// Phase 4 課金: 添付累計サイズ上限チェック (チケット作成時添付と共有)
import { checkAttachmentQuota } from '@/lib/tenant-plan';
// Phase 4: Slack/Teams/Chatwork 外部通知のベストエフォート送信共通ヘルパー
import { notifyOutboundBestEffort } from '@/lib/outbound-notify';
// 同一オリジン検証ヘルパー (§9 CSRF対策。magic-link/callback・POST /api/tickets と共有する
// 判定ロジック。このルートも 1MB ボディ上限回避のため意図的に切り出した通常の Route Handler で、
// Server Action の組み込み Origin 検証を受けないため、ここで明示的に検証する)
import { isSameOriginRequest } from '@/lib/csrf';

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

  // クロスオリジン CSRF 対策: 攻撃者サイトが被害者のブラウザに送らせたクロスサイト POST は
  // セッション Cookie が自動付与されるため auth() だけでは弾けない。同一オリジンからの
  // 送信であることを明示的に検証する (§9)
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ error: 'リクエストの送信元を確認できません' }, { status: 403 });
  }

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

  // Phase 4 課金: 添付ファイルがある場合、テナントの累計サイズ上限 (§6.1 Standard「添付1GB」) を
  // 超えないか確認する。チケット作成時添付と同じ判定ヘルパーを共有する (tenant-plan.ts)
  const newAttachmentBytes = attachmentValidation.files.reduce((sum, f) => sum + f.size, 0);
  const attachmentQuotaCheck = await checkAttachmentQuota(tenantId, newAttachmentBytes);
  if (!attachmentQuotaCheck.ok) {
    return validationError(attachmentQuotaCheck.message, ['files']);
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

  // 監査で発見したギャップ対応: チケット当たりの添付総数上限 (MAX_ATTACHMENTS_PER_TICKET) を
  // 超えないか確認する。1 回のリクエストの件数は validateUploadedFiles (MAX_ATTACHMENTS_PER_UPLOAD)
  // が既に見ているが、コメント追記を繰り返すとチケット単位の総数は際限なく積み上がってしまう
  if (attachmentValidation.files.length > 0) {
    const ticketQuotaCheck = await checkTicketAttachmentQuota(
      repos,
      ticketId,
      tenantId,
      attachmentValidation.files.length,
    );
    if (!ticketQuotaCheck.ok) {
      return validationError(ticketQuotaCheck.message, ['files']);
    }
  }

  // 通知の送信先を決定する (既存 addComment と同じロジック)
  const recipientIds = await resolveCommentRecipients(ticket, authorId, authorIsAgent, tenantId);
  const message = `チケット「${ticket.title}」に新しいコメントが追加されました`;
  // 初回応答日時の記録に使う基準時刻
  const now = new Date();

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

      // SLA: エージェントの初回応答を記録する (SLA §初回応答期限)。
      // 依頼者自身のコメントは「応答」ではないため対象外。既に記録済みなら上書きしない
      // (2 回目以降のエージェントコメントで初回応答日時が後ろにズレるのを防ぐ)
      if (authorIsAgent && !ticket.firstRespondedAt) {
        await r.tickets.markFirstResponded(ticketId, now, tenantId);
      }

      // 添付ファイルがあれば 1 件ずつ「ストレージ書き込み → メタ INSERT」の順に処理する
      // (POST /api/tickets・POST /api/inbound/email と共有するヘルパー。
      // /code-review ultra 指摘対応: 3 箇所で個別実装されていた重複を解消)
      await persistAttachments(
        r,
        attachmentValidation.files,
        ticketId,
        comment.id, // コメントへの添付として記録する
        authorId,
        tenantId,
        writtenKeys,
      );

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
    await cleanupWrittenAttachments(writtenKeys, '[POST /api/tickets/[id]/comments]');
    // 元のエラーをサーバログに残して 500 を返す
    console.error('[POST /api/tickets/[id]/comments] save failed', err);
    return NextResponse.json({ error: 'コメントの保存に失敗しました' }, { status: 500 });
  }

  // 通知対象が 1 名以上いれば未読件数を一斉配信
  if (recipientIds.length > 0) await broadcastUnreadCountToMany(recipientIds, tenantId);

  // Phase 4: Slack/Teams/Chatwork 外部通知 (updateTicketStatus / escalateTicket /
  // updateTicketAssignee と同じパターン)。ステータス変更・エスカレーション・担当者割当は
  // 外部チャネルに通知されるのに、コメント (依頼者からの新着質問・担当者の返信) だけ
  // チーム共有チャネルに一切届かず「対応漏れに気づける」という Phase 4 の目的から抜けていた。
  // アプリ内通知/メール/LINE と同じくベストエフォートで送る (失敗してもコメント投稿は成功扱い)。
  await notifyOutboundBestEffort(
    tenantId,
    (baseUrl) => ({
      subject: `新しいコメントが投稿されました: ${ticket.title}`,
      body: `投稿者: ${session.user.name ?? (authorIsAgent ? '担当者' : '依頼者')}`,
      ticketUrl: buildTicketUrl(baseUrl, ticketId),
    }),
    '[POST /api/tickets/[id]/comments]',
  );

  // Phase 2「対応すると依頼者にメールで返信が届く」「担当者の返信が LINE に返る」
  // (docs/smb-dx-pivot-plan.md §4 Phase 2): 担当者がコメント (返信) した場合は、依頼者が
  // アプリにログインしなくても内容を確認できるよう、メール / LINE (連携済みの場合) で届ける。
  // コメント保存はコミット済みなので両方ともベストエフォートとし、失敗してもレスポンスは
  // 201 のままにする (アプリ内通知 / SSE は既に成立している)。
  if (authorIsAgent) {
    await notifyRequesterOfReply({
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

// 担当者の返信を依頼者へメール / LINE で届ける内部ヘルパー (ベストエフォート)。
// 依頼者の連絡先 (メールアドレス・lineUserId) を 1 度だけ引いて、設定済みのチャネルへ
// 並行して送る。一方が失敗しても他方の送信を妨げないよう、各チャネルは個別に try/catch する。
async function notifyRequesterOfReply(args: {
  ticket: { creatorId: string; title: string };
  authorId: string;
  authorName: string;
  commentBody: string;
  ticketId: string;
  tenantId: string;
}): Promise<void> {
  const { ticket, authorId, authorName, commentBody, ticketId, tenantId } = args;
  // 自分が起票したチケットに自分で返信した場合は自分宛通知を送らない
  if (ticket.creatorId === authorId) return;

  // 依頼者 (起票者) の連絡先をまとめて引く (認証用なのでテナント横断 lookup)。
  // この呼び出し自体は元の sendReplyEmailToRequester でも try/catch の内側にあった DB アクセスで、
  // 一過性の DB 障害でも「コメントは保存できたのに 500 が返る」事態 (フロントの二重投稿誘発) を
  // 避けるためここでも例外を握りつぶす (ベストエフォート通知全体の契約を維持する)。
  let creator: { email: string | null; lineUserId?: string | null } | null;
  try {
    creator = await repos.users.findById(ticket.creatorId);
  } catch (err) {
    console.error('[POST /api/tickets/[id]/comments] 依頼者情報の取得に失敗しました', err);
    return;
  }
  // 依頼者自体が見つからなければメール / LINE どちらも送りようがないので早期 return する。
  if (!creator) return;

  await Promise.all([
    sendReplyEmailToRequester({ creator, ticket, authorName, commentBody, ticketId, tenantId }),
    sendReplyLineToRequester({ creator, ticket, authorName, commentBody, ticketId, tenantId }),
  ]);
}

// 担当者の返信を依頼者へメールで届ける内部ヘルパー (ベストエフォート / 副作用は send のみ)。
// 例外は呼び出し側に伝播させず、ログに残して握り潰す: メール送信の失敗で「コメントは保存できたのに
// 500 が返る」事態 (= フロントが二重投稿しかねない) を避けるため。
async function sendReplyEmailToRequester(args: {
  creator: { email: string | null };
  ticket: { title: string };
  authorName: string;
  commentBody: string;
  ticketId: string;
  tenantId: string;
}): Promise<void> {
  const { creator, ticket, authorName, commentBody, ticketId, tenantId } = args;
  // メール未設定なら送りようがないのでスキップ
  if (!creator.email) return;

  try {
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

// 担当者の返信を依頼者へ LINE で届ける内部ヘルパー (ベストエフォート / 副作用は push のみ)。
// テナントの LINE 連携が未設定、または依頼者が LINE 未連携 (lineUserId なし) の場合は
// 早期 return により何もしない (機能オプトインの正常系)。
async function sendReplyLineToRequester(args: {
  creator: { lineUserId?: string | null };
  ticket: { title: string };
  authorName: string;
  commentBody: string;
  ticketId: string;
  tenantId: string;
}): Promise<void> {
  const { creator, ticket, authorName, commentBody, ticketId, tenantId } = args;
  // LINE 未連携なら送りようがないのでスキップ
  if (!creator.lineUserId) return;

  try {
    // テナントで LINE push が使えるか (連携設定 + プランゲート) を解決する。
    // /code-review ultra 指摘対応: update-ticket.ts の sendStatusChangedLineToRequester と
    // 判定ロジックが重複していたため、resolveLineAccessToken (src/lib/line-push.ts) へ共通化した。
    // プランダウングレード後も TenantLineConfig の行自体は削除されないため (Stripe Webhook は
    // プラン変更のみで LineConfig を削除しない)、UI 非表示に頼らずここでもサーバー側で強制する (§9)。
    const accessToken = await resolveLineAccessToken(tenantId);
    // null は「このテナントでは LINE push が使えない」を意味する (未設定 or プラン非対応)
    if (!accessToken) return;

    // メール内リンクと同じベース URL 解決ロジックを再利用する (single source)
    const baseUrl = resolveAppBaseUrl();
    const ticketUrl = buildTicketUrl(baseUrl, ticketId);
    // LINE 用テキスト本文を純粋ヘルパーで構築
    const text = buildTicketReplyLineMessage({
      ticketTitle: ticket.title,
      ticketUrl,
      commentBody,
      agentName: authorName,
    });
    // Messaging API へ push する (このテナント専用のアクセストークンを使う)
    await pushLineMessage(accessToken, creator.lineUserId, text);
  } catch (err) {
    // 送信失敗はサーバログに残すだけ (依頼者への通知はアプリ内にも残っている)
    console.error('[POST /api/tickets/[id]/comments] 依頼者宛 LINE 送信に失敗しました', err);
  }
}
