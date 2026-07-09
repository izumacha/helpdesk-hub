// JSON / バイナリレスポンスを返すヘルパー
import { NextResponse } from 'next/server';
// セッション取得
import { auth } from '@/lib/auth';
// データ層 (添付メタ + チケット)
import { repos } from '@/data';
// 添付ファイル本体の StoragePort (Edge runtime 汚染回避のため別モジュールから取り込む)
import { storage } from '@/data/storage';
// エージェント権限の判定 (agent | admin で true)
import { isAgent } from '@/lib/role';
// Route Handler 向け共通レート制限ラッパー (inbound-email/inbound-line/sso-acs と共有)
import { checkRouteRateLimit } from '@/lib/route-rate-limit';

// /api/attachments/[id] の動的セグメントを受け取るためのパラメータ型
type Params = { params: Promise<{ id: string }> };

// 監査で発見したギャップ: 添付ファイル ID は cuid で推測困難だが、他の認可済みルートと
// 一貫性を取り、総当たりダウンロード試行に対する多層防御としてレート制限を掛ける
// (CLAUDE.md §9 DoS/リソース枯渇防止)。認証済みユーザー単位で、通常のブラウジング
// (1 チケットに最大 5 枚の添付を連続表示する程度) を妨げない緩めの上限にする
const ATTACHMENT_DOWNLOAD_RATE_LIMIT = { limit: 120, windowMs: 60_000 } as const;

// GET /api/attachments/[id] : 認可されたユーザーに添付ファイルのバイト列を返すエンドポイント。
// 必要な権限チェック:
//   1. ログイン済み かつ テナントが確定している (未認証・tenantId 欠落は 401)
//   2. 添付がセッションのテナント内に存在する (他テナントは 404 として握りつぶす)
//   3. 親チケットの閲覧権限を持つ (requester は自分が起票したチケットのみ可。それ以外は 404)
//   4. 物理ファイルが存在する (storage.get が null → 404)
export async function GET(_req: Request, { params }: Params) {
  // セッション取得
  const session = await auth();
  // 未ログイン、または tenantId が欠落しているセッションは 401 を返す。
  // tenantId が undefined のまま Prisma の findFirst に渡すと where から
  // tenantId 条件が脱落し、全テナントの添付に一致してしまう (クロステナント漏洩)。
  // 通常 JWT コールバックが tenantId を補完するため到達しないが、他の認証ルートと
  // 同様に多層防御として明示的に拒否し、fail-closed に倒す。
  if (!session?.user?.id || !session.user.tenantId) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 });
  }
  // 動的セグメントを取り出す
  const { id } = await params;
  // セッションから tenantId / ロールを取り出す
  const tenantId = session.user.tenantId;
  const userId = session.user.id;
  const isAgentRole = isAgent(session.user.role);

  // ユーザー単位でダウンロード頻度を制限する (他の Route Handler と同じ 429 契約)
  const rateLimitResponse = checkRouteRateLimit(
    `attachment-download:${userId}`,
    ATTACHMENT_DOWNLOAD_RATE_LIMIT,
    'リクエストが多すぎます。しばらく時間をおいて再度お試しください',
  );
  if (rateLimitResponse) return rateLimitResponse;

  // 添付メタを tenantId スコープで取得 (他テナントの ID は null → 404 で握りつぶす)
  const attachment = await repos.attachments.findById(id, tenantId);
  if (!attachment) {
    return NextResponse.json({ error: '添付ファイルが見つかりません' }, { status: 404 });
  }

  // 親チケットの閲覧権限を確認する (requester は自分が起票したチケットのみ可)
  const ticket = await repos.tickets.findById(attachment.ticketId, tenantId);
  // 万一親チケットが消えていたら 404 を返す (Cascade 削除との競合は通常ありえないが防御)
  if (!ticket) {
    return NextResponse.json({ error: '添付ファイルが見つかりません' }, { status: 404 });
  }
  // 依頼者ロールの場合は自分の起票チケットのみ閲覧可。それ以外の組み合わせは 404 として隠す
  // (403 を返すと添付の存在自体が漏れるため、存在を隠す意味で 404 に揃える)
  if (!isAgentRole && ticket.creatorId !== userId) {
    return NextResponse.json({ error: '添付ファイルが見つかりません' }, { status: 404 });
  }

  // ストレージからバイト列を読み出す。物理ファイル消失時は 404
  const bytes = await storage.get(attachment.storageKey);
  if (!bytes) {
    return NextResponse.json({ error: '添付ファイルが見つかりません' }, { status: 404 });
  }

  // 元ファイル名を UTF-8 エンコードして Content-Disposition の filename* に乗せる
  // (日本語ファイル名でもダウンロード時に正しい名前が出るようにする)
  const encodedName = encodeURIComponent(attachment.originalName);
  // 1 時間ブラウザにキャッシュさせる (private = 共有キャッシュ禁止、認可済みユーザー専用)
  // X-Content-Type-Options: nosniff はユーザーアップロード物配信の防御として常時付与する
  // (ブラウザの MIME スニッフィングを無効化し、image/* を script として実行される事故を防ぐ)
  const headers = new Headers({
    'Content-Type': attachment.mimeType,
    'Content-Length': String(bytes.length),
    'Content-Disposition': `inline; filename*=UTF-8''${encodedName}`,
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  });
  // Uint8Array を Blob でラップして Response に詰める
  // (Web 標準では Response の BodyInit に Uint8Array も含まれるが、
  //  TS の lib.dom 型定義では含まれないため Blob 経由で互換性を保つ)
  return new Response(new Blob([new Uint8Array(bytes)], { type: attachment.mimeType }), {
    status: 200,
    headers,
  });
}
