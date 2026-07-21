/**
 * 新しいテナント + 初代管理者 (admin) を 1 組作成する共通ロジック。
 *
 * 業種テンプレに応じたカテゴリ・よくある質問の自動投入、操作感を掴むためのサンプルチケットの
 * 自動作成までを含む (Phase 3 オンボーディング / docs/smb-dx-pivot-plan.md §4 Phase 3)。
 *
 * 管理者が操作する `createTenant`（既存テナントの admin が別組織を作る運用者向けフロー）と、
 * セルフサーブサインアップの `completeSignup`（§7.1「30 分で運用開始」シナリオ）の両方が
 * 同一のロジックを必要とするため、2 箇所目の複製が生じる前にここへ集約する（§6 DRY）。
 *
 * 呼び出し側は `uow.run(...)` のトランザクション内から渡された `tx` (Repos) を使うこと。
 * ユーザー作成失敗 (メール重複等) 時にテナント作成もロールバックさせる責務は呼び出し側の
 * トランザクション境界が担う。
 */

// bcrypt によるパスワードハッシュ化 (seed と同じ cost 12)
import { hash } from 'bcryptjs';
// リポジトリ束の型 (トランザクション対応の Repos を受け取る)
import type { Repos } from '@/data/ports/unit-of-work';
// メール取り込み用の転送アドレストークンを払い出すヘルパー (Phase 2)
import { generateInboundToken } from '@/lib/inbound-email';
// 業種テンプレートの検索関数 (Phase 3 業種テンプレ自動投入)
import { findIndustryTemplate } from '@/lib/industry-templates';
// 優先度から解決期限・初回応答期限を計算する SLA ヘルパー (サンプルチケットの期限算出に使う)
import { calculateFirstResponseDueAt, calculateResolutionDueAt } from '@/lib/sla';
// 新規起票時の初期ステータスを mode から決める共通ルール (サンプルチケットと揃える)
import { initialStatusForMode } from '@/domain/ticket-status';
// Prisma の一意制約違反 (P2002) 判定の共通ヘルパー (§6 DRY: create-location.ts 等と同じヘルパーを再利用)
import { isUniqueConstraintError } from '@/lib/prisma-errors';

// サンプルチケットの定義 (Phase 3 オンボーディング)。
// 新規テナントに操作感を掴ませるために自動投入する 2 件のチケット。
// 内容は業種に関わらず汎用的な例とし、Lite モードに合わせた平易な日本語にする。
const SAMPLE_TICKETS = [
  {
    // 1 件目: システムの操作確認を促す導入チケット
    title: 'はじめての問い合わせ（サンプル）',
    body: 'これはサンプルのチケットです。実際の問い合わせが届いたら、件名・内容・期限を確認して「対応中」に変更してみましょう。\n\n対応が完了したら「完了」に変更することで、この問い合わせを閉じることができます。',
  },
  {
    // 2 件目: メール転送機能の説明チケット
    title: 'メールから自動で問い合わせが届きます（サンプル）',
    body: '設定画面に表示されている転送アドレス宛にメールを転送すると、自動でここに問い合わせが届きます。\n\nGmail や Outlook の「自動転送」機能を使うと、既存のメールアドレスに届いた問い合わせをそのままこのシステムで管理できます。',
  },
] as const;

// provisionTenantWithAdmin の入力
export interface ProvisionTenantInput {
  tenantName: string; // 組織名
  industry: string | undefined; // 業種テンプレ識別子 (未指定なら undefined)
  adminName: string; // 初代管理者の表示名
  adminEmail: string; // 初代管理者のログイン用メール (小文字正規化済みであること)
  adminPassword: string; // 初代管理者の平文パスワード (この関数内で bcrypt ハッシュ化する)
  trialEndsAt: Date; // §7.2 Free trial の終了時刻 (呼び出し側で算出済みの値を渡す)
}

// provisionTenantWithAdmin の戻り値
export interface ProvisionTenantResult {
  tenantId: string; // 作成したテナント ID
  adminId: string; // 作成した初代管理者の User ID
}

// 新しいテナント + 初代管理者を 1 組作成する。呼び出し側のトランザクション (tx) の中で呼ぶこと。
// メール重複時は例外を投げる (呼び出し側のトランザクションがロールバックされ、孤児テナントを残さない)。
export async function provisionTenantWithAdmin(
  tx: Repos,
  input: ProvisionTenantInput,
): Promise<ProvisionTenantResult> {
  // 先にメール重複を確認 (テナントを作る前に弾けるならその方が無駄がない)
  const existing = await tx.users.findByEmail(input.adminEmail);
  if (existing) {
    throw new Error('このメールアドレスは既に登録されています。別のメールを指定してください。');
  }

  // 新しいテナント (組織) を作成する。mode 未指定で SMB 既定の lite になる。
  // メール取り込み (Phase 2) の専用転送アドレス用トークンを払い出して紐付ける
  // (作成時に発行しておくことで、運用者は最初から取り込みアドレスを案内できる)。
  const tenant = await tx.tenants.create({
    name: input.tenantName,
    industry: input.industry ?? null,
    inboundToken: generateInboundToken(),
    trialEndsAt: input.trialEndsAt,
  });
  // パスワードを bcrypt でハッシュ化する (cost 12。seed と同条件)
  const passwordHash = await hash(input.adminPassword, 12);
  // 初代管理者 (admin) を作成テナントに所属させて作る。戻り値を保持して後のサンプル起票で使う
  const adminUser = await tx.users.create({
    email: input.adminEmail,
    name: input.adminName,
    passwordHash,
    role: 'admin',
    tenantId: tenant.id,
  });
  // この後のサンプル起票・FAQ シードチケットで使う基準時刻 (1 回だけ取得して使い回す)
  const now = new Date();
  // 業種テンプレートが指定されている場合はカテゴリ + よくある質問を初期投入する
  // (Phase 3 業種テンプレ: 選択した業種に紐づくカテゴリ・FAQ を作成する)
  if (input.industry) {
    // 指定 ID のテンプレートを取得する (存在しなければ undefined)
    const template = findIndustryTemplate(input.industry);
    // テンプレートが見つかった場合のみカテゴリ・FAQ を順次作成する
    if (template) {
      // Prisma のインタラクティブトランザクション内では 1 つの接続を直列に使うため
      // Promise.all で並列クエリを投げると "Transaction already closed" になる場合がある。
      // for...of + await で直列実行して安全性を保つ (カテゴリ・FAQ は数件なので性能上問題なし)
      for (const name of template.categories) {
        // カテゴリを 1 件ずつトランザクション内で作成する。
        // フォローアップ (2026-07-21): CategoryRepository.create は admin による新規作成
        // (createCategory) と契約を統一するため upsert から plain create (重複時は throw) に
        // 変更した。業種テンプレのカテゴリ名がテンプレート定義内で重複することは想定していないが、
        // 元々の upsert はネットワーク障害・再送によるリトライ時の冪等性 (2 回実行されても
        // エラーにしない) を狙った設計だったため、その安全網をここで維持する
        // (isUniqueConstraintError で判定し、既に存在するなら no-op として無視する)
        try {
          await tx.categories.create({ name, tenantId: tenant.id });
        } catch (err) {
          if (!isUniqueConstraintError(err)) throw err;
        }
      }

      // 「よくある質問」は FaqCandidate.ticketId が必須 (1 チケット 1 候補) のため、
      // テンプレートの Q&A ごとに「解決済み」のシードチケットを 1 件作ってから FAQ 候補を作成し、
      // 公開 (Published) 状態へ更新する。サンプルチケット (SAMPLE_TICKETS) と同じ起票ロジックを使う。
      for (const faq of template.faqs) {
        // FAQ の元になるシードチケットを解決済み (Closed) で作成する
        // 注意: tickets.create は resolvedAt を常に null で作成する (設定するには別途
        // updateStatus が必要)。resolutionDueAt を指定すると、resolvedAt が null のまま
        // 期限だけ過去の時刻になり、getSlaState() が「期限切れ」と誤判定してしまう
        // (status は Closed なのに SLA バッジだけ overdue になる矛盾)。
        // 解決済みシードチケットに本来 SLA 期限は不要なため、resolutionDueAt は指定しない。
        const faqTicket = await tx.tickets.create({
          title: faq.question, // 質問文をそのままタイトルに使う
          body: faq.answer, // 回答文を本文として残す (チケット詳細からも参照できる)
          priority: 'Medium', // 既定の優先度
          categoryId: null, // FAQ シードはカテゴリ未分類
          creatorId: adminUser.id, // 初代管理者を起票者とする
          tenantId: tenant.id, // 所属テナント
          status: 'Closed', // 「よくある質問」は解決済みチケットから化けるという業務フローに合わせる
        });
        // FAQ 候補を作成 (既定は Candidate) してから即座に Published へ更新する
        const faqCandidate = await tx.faq.create({
          ticketId: faqTicket.id,
          createdById: adminUser.id,
          question: faq.question,
          answer: faq.answer,
          tenantId: tenant.id,
        });
        // 直前に作成した候補 (Candidate) を公開状態へ更新する。同一トランザクション内で
        // 作成直後の行を更新するため期待状態 (Candidate) は必ず一致するが、万一更新できなければ
        // 例外でトランザクション全体を失敗させる (§9 fail-closed: 中途半端な投入を残さない)
        const published = await tx.faq.updateStatus(
          faqCandidate.id,
          { from: 'Candidate', to: 'Published' },
          tenant.id,
        );
        // 更新できなかった場合は異常事態として即座に失敗させる
        if (!published) {
          throw new Error(`業種テンプレートFAQの公開に失敗しました (id: ${faqCandidate.id})`);
        }
      }
    }
  }

  // Phase 3 オンボーディング: サンプルチケットを自動投入して操作感を体験できるようにする。
  // 起票者には初代管理者 (adminUser) を設定する。
  // サンプルチケットは Lite モードの既定動作に合わせて初期化する (Pro でも同じ)。
  const initialStatus = initialStatusForMode(tenant.mode);
  // サンプルチケットの解決期限・初回応答期限は優先度 Medium ベースで自動計算する
  // (now は上で取得済みのものを再利用)
  const resolutionDueAt = calculateResolutionDueAt('Medium', now);
  const firstResponseDueAt = calculateFirstResponseDueAt('Medium', now);
  // サンプルチケットを 1 件ずつ直列で作成する (トランザクション内の複数クエリは直列が安全)
  for (const sample of SAMPLE_TICKETS) {
    await tx.tickets.create({
      title: sample.title, // サンプルタイトル
      body: sample.body, // サンプル本文
      priority: 'Medium', // 既定の優先度 (Medium)
      categoryId: null, // サンプルはカテゴリ未分類
      creatorId: adminUser.id, // 初代管理者を起票者とする
      tenantId: tenant.id, // 所属テナント
      status: initialStatus, // Lite は 'Open'、Pro は DB 既定 'New'
      resolutionDueAt, // 自動計算した解決期限
      firstResponseDueAt, // 自動計算した初回応答期限
    });
  }

  // 作成結果を返す
  return { tenantId: tenant.id, adminId: adminUser.id };
}
