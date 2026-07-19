// issue-backlog #20 フォローアップ: SLA 期限接近リマインダーの定期実行エンドポイント。
//
// src/app/api/internal/trial-reminders/route.ts と同じ「daily/hourly cron から叩く」設計。
// GitHub Actions の cron は手動再実行 (workflow_dispatch)・遅延・欠落がありうる best-effort な
// 定期実行であるため、「ちょうどそのタイミングだけ送る」設計ではなく
// Ticket.slaReminderNotifiedForDueAt に「どの期限に対して通知済みか」を永続化することで
// 何度・いつ叩かれても二重送信/取りこぼしが起きないようにしてある
// (src/lib/sla-reminder.ts の needsSlaDueSoonReminder 参照)。
// ユーザー操作ではなく定期実行ジョブから呼ばれる想定のため、認証はセッションではなく
// 共有シークレットで行う (src/middleware.ts の INTERNAL_CRON_ROUTES でセッション認証ガードの
// 対象外にしてある。trial-reminders と同じ扱い)。
//
// セキュリティ:
// 1. Authorization: Bearer <SLA_REMINDER_CRON_SECRET> をタイミング攻撃対策の定数時間比較で
//    検証する (trial-reminders/route.ts と共通ヘルパーを共有)。
// 2. SLA_REMINDER_CRON_SECRET が環境変数に未設定の場合は、リクエストを一切処理せず
//    500 で拒否する (§9 fail-closed。「シークレット未設定 = 誰でも叩ける」を防ぐ)。
// 3. 固定キーのレート制限を認証より前に適用する (trial-reminders と同じ方針)。
// 4. 1 件の通知作成失敗が他のチケットへの通知を止めないよう、チケット単位で try/catch する。

import { NextResponse } from 'next/server';
// データリポジトリ (Composition Root 経由。Prisma を直接 import しない)
import { repos } from '@/data';
// リマインダー要否判定・通知文言組み立ての純粋ヘルパー
import {
  needsSlaDueSoonReminder,
  renderSlaDueSoonMessage,
  SLA_DUE_SOON_QUERY_LIMIT,
} from '@/lib/sla-reminder';
// 未読件数の再配信 (SSE 経由で通知ベルへ即時反映)
import { broadcastUnreadCount } from '@/features/notifications/notify';
// 定数時間比較・Bearer トークン抽出の共通ヘルパー (LINE Webhook 署名検証・trial-reminders と共有)
import { constantTimeStringEqual, extractBearerToken } from '@/lib/timing-safe-compare';
// Route Handler 向け共通レート制限ラッパー (trial-reminders 等と共有)
import { checkRouteRateLimit } from '@/lib/route-rate-limit';

// trial-reminders と同じ考え方: 正規の利用は 1 時間に 1 回程度の cron 実行のみのため、
// 正規利用を妨げない範囲で厳しめの値にする
const SLA_REMINDER_RATE_LIMIT = { limit: 5, windowMs: 60_000 } as const;
const SLA_REMINDER_RATE_LIMIT_MESSAGE =
  'リクエストが多すぎます。しばらくしてから再試行してください';

// POST /api/internal/sla-reminders : SLA 解決期限が警告帯に入った未解決チケットの
// 担当者へアプリ内通知を送る
export async function POST(request: Request): Promise<NextResponse> {
  // 固定キーのレート制限を認証より前に適用する (シークレット比較・DB 走査より前に弾く)
  const rateLimitResponse = checkRouteRateLimit(
    'sla-reminders:unauthenticated',
    SLA_REMINDER_RATE_LIMIT,
    SLA_REMINDER_RATE_LIMIT_MESSAGE,
  );
  // 制限超過なら (429 レスポンスが返っているので) ここで処理を打ち切って返す
  if (rateLimitResponse) return rateLimitResponse;

  // 共有シークレットを環境変数から取得する。未設定なら fail-closed で即座に拒否する
  const secret = process.env.SLA_REMINDER_CRON_SECRET?.trim();
  if (!secret) {
    console.error(
      '[sla-reminders] SLA_REMINDER_CRON_SECRET が未設定のため、このエンドポイントは無効化されています',
    );
    return NextResponse.json({ error: 'このエンドポイントは設定されていません' }, { status: 500 });
  }

  // リクエストの Authorization ヘッダから Bearer トークンを取り出して検証する
  const token = extractBearerToken(request.headers.get('authorization'));
  if (!token || !constantTimeStringEqual(token, secret)) {
    // 認証失敗の理由 (未設定/不一致) を区別せず同一の 401 を返す (総当たり耐性)
    return NextResponse.json({ error: '認証に失敗しました' }, { status: 401 });
  }

  // 現在時刻を 1 度だけ取得し、以降の全判定で使い回す (呼び出し中に時刻が変わる不整合を防ぐ)
  const now = new Date();

  // SLA 警告帯に入った未解決チケットを全テナント横断で一括取得する (§8 上限付き)
  const candidates = await repos.tickets.listSlaDueSoonCandidates(now, SLA_DUE_SOON_QUERY_LIMIT);
  // 上限件数ちょうど返ってきた場合、上限を超えるチケットが黙って切り捨てられている可能性がある。
  // §8「一覧取得は必ず上限を持たせる」の趣旨(サイレントな打ち切りを避ける)に沿ってログに残す
  if (candidates.length === SLA_DUE_SOON_QUERY_LIMIT) {
    console.error(
      `[sla-reminders] 対象チケットが上限 (${SLA_DUE_SOON_QUERY_LIMIT} 件) に達しました。一部のチケットへのリマインダーが漏れている可能性があります`,
    );
  }

  // 送信件数を集計する (レスポンスで運用者に結果を伝える)
  let remindersSent = 0;

  // チケットごとに独立して処理する。1 件の失敗が他のチケットへの通知を止めないよう
  // ループ内で try/catch する
  for (const ticket of candidates) {
    // DB クエリは効率のための粗い事前絞り込みに徹しているため、ここで最終判定を行う
    // (§6 一元管理: 一覧画面のバッジと同じ getSlaState ベースの定義を経由する)
    if (!needsSlaDueSoonReminder(ticket)) continue;
    // needsSlaDueSoonReminder が true を返した時点で resolutionDueAt / assigneeId は非 null
    const resolutionDueAt = ticket.resolutionDueAt!;
    const assigneeId = ticket.assigneeId!;

    try {
      // アプリ内通知を 1 件作成する (担当者宛。tenantId スコープ必須)
      await repos.notifications.create({
        userId: assigneeId,
        type: 'slaDueSoon',
        message: renderSlaDueSoonMessage(ticket.title),
        ticketId: ticket.id,
        tenantId: ticket.tenantId,
      });
      // 通知作成に成功した場合のみ、冪等化フラグ (この期限に対して通知済み) を永続化する。
      // 先に永続化すると、直後の broadcastUnreadCount 失敗時に「通知は作られたのに未読バッジが
      // 更新されない」まま次回以降も再送されなくなる不整合が起きるため、通知作成の後に置く。
      // 既知の制約 (trial-reminders と同じ設計): この永続化自体が例外を投げた場合 (DB 接続断等)、
      // 通知は既に作成済みなのに冪等化フラグだけ書き込めず、次回実行時に同じ期限へ再度通知される
      // (重複通知)。逆の順序 (先にフラグを立ててから通知を作る) にすれば重複は防げるが、
      // 今度は通知作成自体が失敗したときに「フラグだけ立って一度も通知されない」まま
      // (resolutionDueAt が変わらない限り) 永久に再試行されなくなる。後者の「静かに通知が
      // 消える」方が「まれに重複する」より運用上気づきにくく害が大きいため、
      // trial-reminders/route.ts (updateTrialReminderLastSent) と同じくこの順序を採用する
      await repos.tickets.markSlaReminderNotified(ticket.id, resolutionDueAt, ticket.tenantId);
      // 通知作成・冪等化フラグ永続化のいずれも例外を投げなかった (=完了した) 件数として加算する
      remindersSent += 1;
      // 未読カウントを SSE で即時配信して通知ベルに反映させる (ベストエフォート)
      await broadcastUnreadCount(assigneeId, ticket.tenantId).catch((err) => {
        // SSE 配信失敗はバッジ更新が遅れるだけ。ログのみ残して続行する
        console.warn(`[sla-reminders] チケット ${ticket.id}: 未読カウント配信に失敗しました`, err);
      });
    } catch (err) {
      // 1 件分の失敗はログに残すだけで処理を継続する (内部詳細はログのみ、レスポンスには含めない)
      console.error(`[sla-reminders] チケット ${ticket.id} への通知送信に失敗しました:`, err);
    }
  }

  // 運用者向けに処理件数を返す (機微情報は含まない)
  return NextResponse.json({ checked: candidates.length, remindersSent });
}
