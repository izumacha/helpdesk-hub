'use server';

// メール取り込み用の転送先アドレス (inboundToken) を (再)発行する Server Action。
// 対象ケースは 2 つ:
//  (a) 20260619000000_add_tenant_inbound_token マイグレーション以前から存在し、
//      inboundToken が未発行 (null) のままのテナントへの初回発行。
//  (b) 既存の転送先アドレスが漏洩・スパム混入した場合の再発行 (ローテーション)。
// 管理者専用。docs/smb-dx-pivot-plan.md §4 Phase 2「メール取り込み」フォローアップ
// (自己診断で見つかった「案内文言はあるが自己発行手段が無い」不整合の解消)。

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
// メール取り込み用トークンを生成するヘルパー (暗号学的乱数・16文字)
import { generateInboundToken } from '@/lib/inbound-email';
// テナントの実効プラン (トライアル昇格を含む) を解決する共通ヘルパー
import { resolveTenantPlan } from '@/lib/tenant-plan';
// プランゲート: メール取り込みは Standard 以上のみ利用可能 (§6.1 料金プラン)
import { isEmailInboundAllowed } from '@/lib/plan-guard';

// メール取り込み用トークンを (再)発行するサーバーアクション。フォーム入力は使わないため
// formData は受け取らず、管理者権限のみを確認して即座に新トークンを発行する
export async function regenerateInboundToken(): Promise<void> {
  // セッション取得
  const session = await auth();
  // 管理者権限を要求 (失敗時は日本語エラーを throw)
  assertAdminSession(session);
  // セッションから tenantId を取り出す (更新対象はログイン中テナントのみ = クロステナント防止)
  const tenantId = session.user.tenantId;

  // プランゲート: 設定画面はメール取り込み許可プランのときだけボタンを描画するが、
  // UI 非表示に頼らずサーバー側でも強制する (update-tenant-mode.ts の Pro ゲートと同じ方針)。
  // 未許可プランのテナントにトークンだけが発行される (Webhook 側で結局隔離される) 状態を防ぐ
  const plan = await resolveTenantPlan(tenantId);
  if (!isEmailInboundAllowed(plan)) {
    throw new Error('メール取り込みは Standard 以上のプランでご利用いただけます。');
  }

  // 発行操作の連打を抑制 (60 秒あたり 3 回まで、テナント単位)。
  // 頻繁な再発行は転送先アドレスの使い回しができなくなる運用上のリスクであり、これは
  // テナント全体で共有される 1 つのアドレスに対する制約なので、実行した管理者個人ではなく
  // テナント単位でキーを切る (同一テナントの複数管理者が個別の枠を持ってしまうと
  // 合計の再発行回数が管理者数倍になり、制限の意図を損なうため)
  enforceRateLimit(`inbound-token-regenerate:${tenantId}`, { limit: 3, windowMs: 60_000 });

  try {
    // 新しいトークンを生成してテナントに紐づける (既存トークンがあれば上書き = 旧アドレスは即座に無効化)
    await repos.tenants.updateInboundToken(tenantId, generateInboundToken());
  } catch (err) {
    // inboundToken は @unique 列のため、極めて低確率だが生成したトークンが既存の値と
    // 衝突した場合は一意制約違反になる (create-location.ts / update-line-config.ts と同じ
    // 検出パターン)。内部詳細 (Prisma のエラー文言) はクライアントに漏らさない (§9)
    const message = err instanceof Error ? err.message : '';
    console.error('[regenerate-inbound-token] トークン発行に失敗しました:', err);
    if (message.includes('Unique constraint') || message.includes('P2002')) {
      throw new Error('発行に失敗しました。もう一度お試しください。');
    }
    throw new Error('転送先アドレスの発行に失敗しました。しばらく後にもう一度お試しください。');
  }

  // 設定画面のキャッシュを無効化して新しい転送先アドレスを再描画させる
  revalidatePath('/settings');
}
