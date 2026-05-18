// JSON / バイナリレスポンスを返すヘルパー
import { NextResponse } from 'next/server';
// セッション取得
import { auth } from '@/lib/auth';
// データ層 (添付メタ + チケット + ストレージ)
import { repos, storage } from '@/data';
// エージェント権限の判定 (agent | admin で true)
import { isAgent } from '@/lib/role';

// /api/attachments/[id] の動的セグメントを受け取るためのパラメータ型
type Params = { params: Promise<{ id: string }> };

// GET /api/attachments/[id] : 認可されたユーザーに添付ファイルのバイト列を返すエンドポイント。
// 必要な権限チェック:
//   1. ログイン済み (未認証は 401)
//   2. 添付がセッションのテナント内に存在する (他テナントは 404 として握りつぶす)
//   3. 親チケットの閲覧権限を持つ (requester は自分が起票したチケットのみ可。それ以外は 404)
//   4. 物理ファイルが存在する (storage.get が null → 404)
export async function GET(_req: Request, { params }: Params) {
  // セッション取得
  const session = await auth();
  // 未ログインなら 401 を返す
  if (!session?.user?.id) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 });
  }
  // 動的セグメントを取り出す
  const { id } = await params;
  // セッションから tenantId / ロールを取り出す
  const tenantId = session.user.tenantId;
  const userId = session.user.id;
  const isAgentRole = isAgent(session.user.role);

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
  const headers = new Headers({
    'Content-Type': attachment.mimeType,
    'Content-Length': String(bytes.length),
    'Content-Disposition': `inline; filename*=UTF-8''${encodedName}`,
    'Cache-Control': 'private, max-age=3600',
  });
  // Uint8Array を Blob でラップして Response に詰める
  // (Web 標準では Response の BodyInit に Uint8Array も含まれるが、
  //  TS の lib.dom 型定義では含まれないため Blob 経由で互換性を保つ)
  return new Response(new Blob([new Uint8Array(bytes)], { type: attachment.mimeType }), {
    status: 200,
    headers,
  });
}
