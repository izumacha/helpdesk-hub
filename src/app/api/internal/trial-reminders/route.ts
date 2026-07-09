// Phase 4 運用 (継続): §7.2 Free trial 終了リマインダーの定期実行エンドポイント。
// docs/smb-dx-pivot-plan.md §7.2「30日間の Free trial (Standard 相当)」フォローアップ。
//
// scripts/backup-db.sh + .github/workflows/backup.yml と同じ「daily cron から叩く」設計。
// ユーザー操作ではなく GitHub Actions の定期実行 (または任意の外部 cron) から 1 日 1 回だけ
// 呼ばれる想定のため、認証はセッションではなく共有シークレットで行う。
//
// セキュリティ:
// 1. Authorization: Bearer <TRIAL_REMINDER_CRON_SECRET> をタイミング攻撃対策の定数時間比較で
//    検証する (src/app/api/inbound/line/route.ts の verifyLineSignature と同じ方式)。
// 2. TRIAL_REMINDER_CRON_SECRET が環境変数に未設定の場合は、リクエストを一切処理せず
//    500 で拒否する (§9 fail-closed。「シークレット未設定 = 誰でも叩ける」を防ぐ)。
// 3. 1 テナントの送信失敗が他テナントへの送信を止めないよう、テナント単位で try/catch する
//    (src/features/tickets/actions/update-ticket.ts の一斉通知送信と同じ方針)。

import { NextResponse } from 'next/server';
// タイミング攻撃対策の定数時間比較
import { timingSafeEqual } from 'node:crypto';
// データリポジトリ (Composition Root 経由。Prisma を直接 import しない)
import { repos } from '@/data';
// リマインダー要否判定・メール本文組み立ての純粋ヘルパー
import {
  shouldSendTrialReminder,
  daysUntilTrialEnds,
  renderTrialReminderEmail,
  TRIAL_REMINDER_QUERY_LIMIT,
} from '@/lib/trial-reminder';
// メール送信の Composition Root
import { getEmailSender } from '@/lib/email';
// アプリの公開ベース URL (メール内の設定画面リンク組み立てに使う)
import { resolveAppBaseUrl } from '@/lib/app-url';

// Authorization ヘッダの "Bearer <token>" から token 部分だけを取り出す。
// 形式が違えば null を返す (呼び出し側で認証失敗として扱う)
function extractBearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer (.+)$/);
  return match ? match[1] : null;
}

// 定数時間比較で 2 つの文字列が一致するか判定する (タイミング攻撃対策)
function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // 長さが違えば timingSafeEqual が例外を投げるため先に弾く (早期 false で問題ない:
  // 攻撃者は正解の長さを知り得ても、文字自体の推測難易度は変わらない)
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// POST /api/internal/trial-reminders : Free trial 終了間近のテナント管理者へリマインダーメールを送る
export async function POST(request: Request): Promise<NextResponse> {
  // 共有シークレットを環境変数から取得する。未設定なら fail-closed で即座に拒否する
  // (production での設定漏れに気づけるよう、CLAUDE.md §9 のパターンに合わせて起動時ではなく
  // リクエスト時にエラーにする。この経路はユーザー向けではなく運用者の cron 設定ミスなので、
  // 詳細をレスポンスに含めても内部情報の漏洩にはならない)
  const secret = process.env.TRIAL_REMINDER_CRON_SECRET?.trim();
  if (!secret) {
    console.error(
      '[trial-reminders] TRIAL_REMINDER_CRON_SECRET が未設定のため、このエンドポイントは無効化されています',
    );
    return NextResponse.json({ error: 'このエンドポイントは設定されていません' }, { status: 500 });
  }

  // リクエストの Authorization ヘッダから Bearer トークンを取り出して検証する
  const token = extractBearerToken(request.headers.get('authorization'));
  if (!token || !timingSafeStringEqual(token, secret)) {
    // 認証失敗の理由 (未設定/不一致) を区別せず同一の 401 を返す (総当たり耐性)
    return NextResponse.json({ error: '認証に失敗しました' }, { status: 401 });
  }

  // 現在時刻を 1 度だけ取得し、以降の全判定で使い回す (呼び出し中に日付が変わる不整合を防ぐ)
  const now = new Date();
  // 公開ベース URL (メール内の設定画面リンクに使う)
  const baseUrl = resolveAppBaseUrl();

  // Free プランかつトライアル進行中のテナントを一括取得する (§8 上限付き)
  const trialTenants = await repos.tenants.listActiveTrials(now, TRIAL_REMINDER_QUERY_LIMIT);

  // 送信件数を集計する (レスポンスで運用者に結果を伝える)
  let remindersSent = 0;

  // テナントごとに独立して処理する。1 テナントの失敗が他テナントの送信を止めないよう
  // ループ内で try/catch する
  for (const tenant of trialTenants) {
    // listActiveTrials の契約上 trialEndsAt は必ず設定されているが、型上は Date | null なので
    // ここでガードする (万一 null なら送信対象外としてスキップ)
    if (!tenant.trialEndsAt) continue;
    // 今日がちょうどリマインダー送信日でなければ何もしない
    if (!shouldSendTrialReminder(tenant.trialEndsAt, now)) continue;

    try {
      // このテナントの管理者 (admin のみ) の email を取得する
      const admins = await repos.users.listAdminEmails(tenant.id);
      // 管理者が 1 人もいない (通常は起こらないが、運用上の異常データを想定した防御) 場合はスキップ
      if (admins.length === 0) continue;

      // メール本文を組み立てる (残り日数・組織名・設定画面リンク)
      const { subject, text, html } = renderTrialReminderEmail({
        tenantName: tenant.name,
        daysRemaining: daysUntilTrialEnds(tenant.trialEndsAt, now),
        settingsUrl: `${baseUrl}/settings`,
      });

      // 管理者全員へ送信する (通常は 1 人だが、複数管理者がいるテナントも想定する)
      for (const admin of admins) {
        await getEmailSender().send({ to: admin.email, subject, text, html });
      }
      remindersSent += 1;
    } catch (err) {
      // 1 テナント分の失敗はログに残すだけで処理を継続する (内部詳細はログのみ、レスポンスには含めない)
      console.error(
        `[trial-reminders] テナント ${tenant.id} へのリマインダー送信に失敗しました:`,
        err,
      );
    }
  }

  // 運用者向けに処理件数を返す (機微情報は含まない)
  return NextResponse.json({ checked: trialTenants.length, remindersSent });
}
