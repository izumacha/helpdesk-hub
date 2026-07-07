// テナントの現在プランを解決する共通ヘルパー。
//
// audit ページ・updateTenantMode・LINE 連携コード発行など、複数の Server Action / ページで
// 「テナントを読み込み、見つからなければ (または未取得なら) free 扱いにする」という同じ処理が
// 個別に書かれていたため 1 か所に集約する。src/lib/plan-guard.ts は DB に依存しない純粋関数のみを
// 置く方針 (tests/plan-guard.test.ts が @/data をモックせず素の関数として検証しているため) なので、
// DB 参照を伴うこのヘルパーは別ファイルに分離する
// (src/lib/sso-context.ts が isSsoAllowed の上にテナント参照を重ねているのと同じ考え方)。

// データ層の Composition Root (Prisma 直叩きを避ける入口)
import { repos } from '@/data';
// リポジトリ束の型 (トランザクション内の tx / 非トランザクションの repos のどちらも受け取れるようにする)
import type { Repos } from '@/data/ports/unit-of-work';
// 課金プランの型
import type { SubscriptionPlan } from '@/domain/types';
// 月間チケット上限・スタッフ上限・添付累計サイズ上限の判定ヘルパー
// (プランごとの上限値は plan-guard.ts が単一の源)
import {
  getAttachmentSizeLimit,
  getMonthlyTicketLimit,
  getUserLimit,
  isUserLimitReached,
  resolveEffectivePlan,
} from '@/lib/plan-guard';
// JST (日本時間) 基準の月初を計算する共通ヘルパー (endOfDayJST と同じファイルに集約)
import { startOfMonthJST } from '@/lib/format-date';
// バイト数を GB 表示に丸めるヘルパー (添付上限エラーメッセージ用)
import { formatBytesAsGb } from '@/domain/attachment';

// 指定テナントの現在の実効プランを返す。テナントが見つからない場合は 'free' として扱う
// (fail-closed: 存在しない/取得できないテナントに Pro/Enterprise 限定機能を渡さない)。
// §7.2 Free trial 中 (subscriptionPlan=free かつ trialEndsAt が未来) は Standard 相当に
// 昇格させる (resolveEffectivePlan)。この関数を経由する呼び出し側は全てトライアルの
// 恩恵を自動的に受ける
export async function resolveTenantPlan(tenantId: string): Promise<SubscriptionPlan> {
  // テナントをリポジトリ経由で取得する
  const tenant = await repos.tenants.findById(tenantId);
  // 見つからなければ 'free' にフォールバックする
  if (!tenant) return 'free';
  // トライアル中なら Standard 相当に昇格させた実効プランを返す
  return resolveEffectivePlan(tenant.subscriptionPlan, tenant.trialEndsAt);
}

// 月間チケット起票数の残枠を表す (Web フォーム・CSV インポート・メール/LINE 取り込みが共有する)
export interface MonthlyTicketQuota {
  limited: boolean; // 上限のあるプランか (無制限プランなら false)
  limit: number; // 上限件数 (無制限なら -1。表示用に plan-guard.ts の規約をそのまま流用)
  remaining: number; // 今すぐ作成できる残り件数 (無制限なら Infinity)
}

// 指定テナントの当月チケット起票の残枠を取得する。
// Web フォーム (POST /api/tickets) だけでなく、CSV インポート・メール取り込み・LINE 取り込みなど
// チケットを作成する全ての入口で同じ判定を使うための共通ヘルパー (§6.1 料金プランの月間上限)。
// plan を既に把握している呼び出し側は渡せる (二重の tenant 取得を避ける)。
//
// 注意点 (best-effort な上限であり、DB レベルの原子性は持たない):
// - テナントが見つからない場合は resolveTenantPlan の規約どおり 'free' として扱う (fail-closed)。
//   旧 tickets/route.ts のインライン実装は tenant が null なら上限チェック自体を skip していたが、
//   本来ここには到達しない (User.tenantId → Tenant は Prisma スキーマで cascade 削除のため、
//   セッションの tenantId が指す Tenant 行が消えることはない) ため実害はなく、より安全な
//   fail-closed 側へ寄せている。
// - この関数は「呼び出し時点のスナップショット」を返すだけで、以降の作成処理と同一トランザクション
//   では実行されない。同一テナントへの同時並行インポート/起票がある場合、複数の呼び出しが同じ
//   残枠を見て、合計では上限をわずかに超えることがありうる (check-then-act)。課金プランの利用制限
//   は完全な原子性を要求しない運用上のソフトリミットとして扱っており、原子的なカウンタが必要になれば
//   ここを DB 側の集計 (トランザクション内 SELECT ... FOR UPDATE 等) に差し替える。
export async function getMonthlyTicketQuota(
  tenantId: string,
  plan?: SubscriptionPlan,
): Promise<MonthlyTicketQuota> {
  // プラン未指定なら解決する
  const resolvedPlan = plan ?? (await resolveTenantPlan(tenantId));
  // このプランの月間上限を取得する (-1 = 無制限)
  const limit = getMonthlyTicketLimit(resolvedPlan);
  // 無制限プランは DB 集計を行わず即座に返す (不要なクエリを避ける)
  if (limit === -1) {
    return { limited: false, limit: -1, remaining: Infinity };
  }
  // 当月の起票数をカウントする (「当月」は JST 基準。UTC 月境界だと JST 深夜帯で
  // 集計対象月がずれてしまうため、他の日付処理 (endOfDayJST 等) と同じく JST に統一する)
  // 月初 00:00:00.000 (JST) を起点にする
  const monthStart = startOfMonthJST();
  // 当月起票済み件数をカウントする (tenantId スコープ + createdAfter フィルター)
  const currentCount = await repos.tickets.count({ createdAfter: monthStart }, tenantId);
  // 残枠は 0 未満にならないようクランプする
  return { limited: true, limit, remaining: Math.max(0, limit - currentCount) };
}

// スタッフ (agent/admin) シートの空き状況を表す (呼び出し側がメッセージ文言を組み立てるための最小情報)
export interface SeatAvailability {
  available: boolean; // 空きがあれば true (新規追加してよい)
  limit: number; // このプランのスタッフ上限 (UI/エラー表示用。無制限なら -1)
}

// 指定テナントのスタッフシートに空きがあるかを判定する。
// 招待発行 (create-invitation.ts) と招待受諾 (accept-invitation.ts) の双方が同じ
// 「テナント取得 → 現在人数カウント → 上限判定」を必要とするため 1 か所に集約する (§6 DRY)。
// 呼び出し側がトランザクション内 (tx) か通常の repos かを問わず使えるよう Repos 型を受け取る。
// エラーメッセージは文脈 (発行者向け / 受諾者向け) で異なるため、呼び出し側が組み立てる。
export async function checkSeatAvailability(
  repos: Repos,
  tenantId: string,
): Promise<SeatAvailability> {
  // テナントを取得する
  const tenant = await repos.tenants.findById(tenantId);
  // フェイルセーフ: テナントが取得できない場合は判定を行わず「空きあり」を返し、
  // 後続の DB 操作 (FK 制約) 側で本来の失敗理由が表面化するのに任せる
  // (User.tenantId → Tenant は Prisma スキーマで cascade 削除のため通常発生しない)
  if (!tenant) return { available: true, limit: -1 };
  // このテナントの現在のスタッフ (agent + admin) 数を数える
  const currentUserCount = await repos.users.countByTenant(tenantId);
  // §7.2 Free trial 中なら Standard 相当のシート数を適用する
  const effectivePlan = resolveEffectivePlan(tenant.subscriptionPlan, tenant.trialEndsAt);
  // 上限判定結果とプランの上限値を返す
  return {
    available: !isUserLimitReached(effectivePlan, currentUserCount),
    limit: getUserLimit(effectivePlan),
  };
}

// 添付ファイルの累計サイズの残枠を表す (Web フォーム・コメント投稿の添付アップロードが共有する)
export interface AttachmentQuota {
  limited: boolean; // 上限のあるプランか (無制限プランなら false)
  limitBytes: number; // 上限バイト数 (無制限なら -1。plan-guard.ts の規約をそのまま流用)
  usedBytes: number; // 現在の累計バイト数 (無制限プランでは DB 集計をスキップし 0 固定)
  remainingBytes: number; // 今すぐアップロードできる残りバイト数 (無制限なら Infinity)
}

// 指定テナントの添付ファイル累計サイズの残枠を取得する。
// POST /api/tickets (チケット作成時添付) と POST /api/tickets/[id]/comments (コメント添付) の
// 両方が同じ判定を使うための共通ヘルパー (§6.1 料金プラン Standard「添付1GB」)。
// plan を既に把握している呼び出し側は渡せる (二重の tenant 取得を避ける)。
//
// getMonthlyTicketQuota と同じく best-effort な上限であり、DB レベルの原子性は持たない
// (check-then-act。同時並行アップロードでは合計が上限をわずかに超えうる)。
export async function getAttachmentQuota(
  tenantId: string,
  plan?: SubscriptionPlan,
): Promise<AttachmentQuota> {
  // プラン未指定なら解決する
  const resolvedPlan = plan ?? (await resolveTenantPlan(tenantId));
  // このプランの添付累計サイズ上限を取得する (-1 = 無制限)
  const limitBytes = getAttachmentSizeLimit(resolvedPlan);
  // 無制限プランは DB 集計を行わず即座に返す (不要なクエリを避ける)
  if (limitBytes === -1) {
    return { limited: false, limitBytes: -1, usedBytes: 0, remainingBytes: Infinity };
  }
  // 現在の累計サイズをテナントスコープで集計する
  const usedBytes = await repos.attachments.sumSizeByTenant(tenantId);
  // 残枠は 0 未満にならないようクランプする
  return {
    limited: true,
    limitBytes,
    usedBytes,
    remainingBytes: Math.max(0, limitBytes - usedBytes),
  };
}

// 添付アップロードの残枠チェック結果 (超過時のみ日本語メッセージを持つ)
export type AttachmentQuotaCheck = { ok: true } | { ok: false; message: string };

// アップロードしようとしているファイル群の合計サイズが、テナントの添付累計上限を
// 超えないかを判定する。POST /api/tickets と POST /api/tickets/[id]/comments の
// 両方が同じ判定 + 同じエラーメッセージを使うための共通ヘルパー (§6 DRY)。
// newBytesTotal が 0 (添付なし) なら DB 集計を行わず即座に許可する。
export async function checkAttachmentQuota(
  tenantId: string,
  newBytesTotal: number,
  plan?: SubscriptionPlan,
): Promise<AttachmentQuotaCheck> {
  // 添付が無いアップロードは常に許可 (不要なクエリを避ける)
  if (newBytesTotal <= 0) return { ok: true };
  // 現在の残枠を取得する
  const quota = await getAttachmentQuota(tenantId, plan);
  // 上限のあるプランで、今回の合計サイズが残枠を超えるなら拒否メッセージを返す
  if (quota.limited && newBytesTotal > quota.remainingBytes) {
    return {
      ok: false,
      message: `添付ファイルの合計サイズがプランの上限 (${formatBytesAsGb(quota.limitBytes)}GB) を超えています`,
    };
  }
  // 残枠内なので許可
  return { ok: true };
}
