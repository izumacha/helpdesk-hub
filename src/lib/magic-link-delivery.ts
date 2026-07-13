/**
 * 既存ユーザー宛にログイン用マジックリンクを発行・送信する共通ロジック。
 *
 * `requestMagicLink` (ログインタブからの発行) と、セルフサーブサインアップの
 * `requestSignup`（既に登録済みのメールで要求された場合はサインアップではなくログインリンクを
 * 送る §7.1 フォローアップ）の両方が必要とするため、2 箇所目の複製が生じる前にここへ集約する
 * (§6 DRY)。呼び出し側が列挙耐性のマスク (常に同じ応答を返す) を担当し、この関数は
 * 「ユーザーが存在すれば送る、存在しなければ何もしない」という内部処理だけに責務を絞る。
 */

// データ層の Composition Root (Prisma 直叩きを避けるための入口)
import { repos } from '@/data';
// マジックリンク用の純粋ヘルパー (トークン生成・ハッシュ・URL 構築・メール本文 + 各種定数)
import {
  buildMagicLinkUrl,
  generateMagicLinkToken,
  hashMagicLinkToken,
  MAGIC_LINK_RATE_LIMIT_MAX,
  MAGIC_LINK_RATE_LIMIT_WINDOW_MS,
  MAGIC_LINK_TTL_MS,
  renderMagicLinkEmail,
} from '@/lib/magic-link';
// 環境変数で切り替わる EmailSender の型
import type { EmailSender } from '@/lib/email';

// 実際にトークン発行 + メール送信を行う。User が見つからない or レート上限超過なら何もしない。
// /code-review ultra 指摘対応 (2026-07-13): requestSignup.ts の呼び出し元は分岐判定のために
// 既に repos.users.findByEmail(email) を実行済みであることが多く、この関数内でも同じ検索を
// 繰り返すと 1 リクエストあたり無駄な DB ラウンドトリップが発生する。呼び出し元が既に存在確認
// 済みなら knownUserExists で結果を渡せるようにし (省略時は従来どおりこの関数内で検索する)、
// request-magic-link.ts のような「まだ確認していない」呼び出し元の挙動は変えない
export async function deliverMagicLinkIfUserExists(
  email: string,
  ctx: { baseUrl: string; sender: EmailSender },
  knownUserExists?: boolean,
): Promise<void> {
  // 期限切れトークンを一括掃除 (ベストエフォート。User の有無に関係なく行う)
  await repos.magicLinks.deleteExpired(new Date());

  // 同一メール宛の直近発行件数を取得 (発行スパム対策のレート制限)。
  // 注意: count → check → create が原子的でないため、同一メールへの並行リクエストが
  // 完全に同じタイミングで来た場合、両方が recent < MAX を観測して上限を 1-2 件超過
  // し得る (soft cap)。SMB Lite スケールでは同一ユーザーから ms 単位の並行要求は
  // 想定外なので許容。厳密化が必要になったら pg_advisory_xact_lock などで原子化する
  // (フォローアップ課題)
  const since = new Date(Date.now() - MAGIC_LINK_RATE_LIMIT_WINDOW_MS);
  const recent = await repos.magicLinks.countRecentByEmail(email, since);
  // 上限超過なら新規発行をスキップ (例外は投げない: 列挙対策で呼び出し側からは成功/失敗が見えない)
  if (recent >= MAGIC_LINK_RATE_LIMIT_MAX) return;

  // 呼び出し元が既に存在確認済みならその結果を使い、未指定ならここで検索する (テナント横断 lookup)
  const userExists = knownUserExists ?? (await repos.users.findByEmail(email)) !== null;
  // 未登録のメールに対しては何も発行しない (列挙されない)
  if (!userExists) return;

  // 256-bit のランダムトークンを生成し、SHA-256 ハッシュを DB に記録する (Web Crypto は async)
  const rawToken = generateMagicLinkToken();
  const tokenHash = await hashMagicLinkToken(rawToken);
  // 失効時刻 (現在時刻 + TTL)
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS);
  // DB に保存 (生トークンは保存しない)
  const created = await repos.magicLinks.create({ email, tokenHash, expiresAt });

  // 呼び出し元で解決済みの baseUrl を使ってクリック先 URL を組み立てる
  const url = buildMagicLinkUrl(ctx.baseUrl, rawToken);
  // 件名 + 本文 (Text / HTML) を構築
  const { subject, text, html } = renderMagicLinkEmail({
    url,
    expiresInMinutes: Math.floor(MAGIC_LINK_TTL_MS / 60_000),
  });

  // 呼び出し元で取得済みの EmailSender 経由で送信。送信に失敗したら作ったトークン行を
  // 削除して rate limit の枠を消費させない (SMTP 不調で連打した結果、ユーザーが
  // メール 1 通も受け取れないまま上限に達する事故を防ぐ)
  try {
    await ctx.sender.send({ to: email, subject, text, html });
  } catch (err) {
    // ベストエフォートで行を削除。削除自体の失敗は無視する (元エラーを優先したい)
    await repos.magicLinks.deleteById(created.id).catch(() => undefined);
    // 元の送信エラーを再 throw (呼び出し側の try-catch で握り潰される想定)
    throw err;
  }
}
