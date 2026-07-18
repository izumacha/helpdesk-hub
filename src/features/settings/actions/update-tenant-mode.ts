'use server';

// ページキャッシュを無効化する Next.js の関数
import { revalidatePath } from 'next/cache';
// 現在のセッション (ログイン中ユーザー) を取得
import { auth } from '@/lib/auth';
// リポジトリ束 (repos) を取り込む (Prisma 直叩きを避ける)
import { repos } from '@/data';
// 連打防止のための共通レート制限ヘルパー
import { enforceRateLimit } from '@/lib/rate-limit';
// 管理者権限を強制する共通アサーション (組織設定系で共有)
import { assertAdminSession } from '@/lib/role';
// テナントモード入力 (lite | pro) の Zod 検証スキーマ
import { tenantModeSchema } from '@/lib/validations/tenant';
// Pro モード機能のプランゲート (§6.1 料金プラン: Pro / Enterprise のみ利用可能)
import { isProModeAllowed, PRO_MODE_ALLOWED_PLANS } from '@/lib/plan-guard';
// テナントの現在プランを解決する共通ヘルパー (複数箇所での重複を避ける)
import { resolveTenantPlan } from '@/lib/tenant-plan';
// 設定変更監査ログへの記録を共通化するヘルパー
import { recordSettingsAudit } from '@/lib/settings-audit';

// テナントの動作モード (lite | pro) を切り替えるサーバーアクション
export async function updateTenantMode(formData: FormData): Promise<void> {
  // セッション取得
  const session = await auth();
  // 管理者権限を要求 (失敗時は日本語エラーを throw)
  assertAdminSession(session);
  // セッションから tenantId を取り出す (更新対象はログイン中テナントのみ = クロステナント防止)
  const tenantId = session.user.tenantId;
  // 設定変更の連打を抑制 (60 秒あたり 10 回まで、ユーザー単位)
  enforceRateLimit(`tenant-mode:${session.user.id}`, { limit: 10, windowMs: 60_000 });

  // フォームから mode の生値を取り出す (input[name="mode"])
  const rawMode = formData.get('mode');
  // Zod で 'lite' | 'pro' のいずれかであることを検証 (不正値は拒否)
  const parsed = tenantModeSchema.safeParse(rawMode);
  // 検証失敗ならユーザー向け日本語メッセージで throw
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'モードの指定が正しくありません');
  }

  // テナントの mode 列を更新する (id はセッション由来の tenantId のみ)。ここで parsed.data を
  // 'pro'/'lite' の literal に narrow してから updateMode を呼ぶことで、port 側のオーバーロード
  // (mode:'pro' のときだけ expectedPlanIn を必須にする) を型レベルで正しく選択させる
  // (/code-review ultra 指摘対応: expectedPlanIn が省略可能な単一シグネチャのままだと、渡し
  // 忘れてもコンパイルが通ってしまい CAS 保護が黙って無効化されるため)。
  let updated: boolean;
  if (parsed.data === 'pro') {
    // プランゲート: Pro モードへの切替は Pro / Enterprise プランのみ (Free / Standard では不可
    // §6.1)。UI 非表示に頼らずサーバー側で強制する。
    const plan = await resolveTenantPlan(tenantId);
    if (!isProModeAllowed(plan)) {
      throw new Error('Pro モードは Pro / Enterprise プランでご利用いただけます。');
    }
    // 監査で発見したギャップ対応: 上の isProModeAllowed 判定だけでは、判定とこの書き込みの間に
    // Stripe Webhook 由来の自動ダウングレード (applyPlanChange) が割り込むと古いプラン判定の
    // まま上書きしてしまう TOCTOU が残る。expectedPlanIn を渡した原子的な更新 (CAS) にすることで、
    // 書き込み時点でも現在のプランが許可リストに含まれることを DB レベルで保証する。
    updated = await repos.tenants.updateMode(tenantId, 'pro', [...PRO_MODE_ALLOWED_PLANS]);
  } else {
    // 'lite' への切替はどのプランでも常に許可されるため無条件更新
    updated = await repos.tenants.updateMode(tenantId, 'lite');
  }
  if (!updated) {
    // 0 件更新 = 判定後にプランが変わった (Stripe 由来のダウングレード等) ことによる競合
    throw new Error(
      'モードを変更できませんでした。プランが変更された可能性があるため、画面を再読み込みしてください。',
    );
  }

  // モード変更はラベル・遷移表・メニュー表示など広範囲に影響するため、
  // 設定画面と主要画面 (一覧 / ダッシュボード) のキャッシュを無効化して再描画させる
  revalidatePath('/settings');
  revalidatePath('/tickets');
  revalidatePath('/dashboard');

  // §4.3 フォローアップ: 監査ログに「誰がモードを変更したか」を記録する
  await recordSettingsAudit({
    tenantId,
    actorId: session.user.id,
    action: 'tenant_mode_update',
    logPrefix: '[update-tenant-mode]',
  });
}
