// ダッシュボードの品質指標 (対応品質) の取得を 1 か所に集約するモジュール。
//
// 監査フォローアップ (2026-09-09) で 2 つの欠陥を同時に塞ぐ:
// 1. **全期間集計の凍結**: qualityMetrics の `since` を渡していなかったため、指標が
//    サービス開始以来の累積平均になり、データが蓄積するほど数字が動かなくなっていた
//    (改善しても悪化しても画面に現れない = 指標として機能停止する)。
//    「直近 QUALITY_METRICS_WINDOW_DAYS 日」の移動窓に変更し、いまの対応品質を映す。
//    なお窓は port 側で **各指標の出来事が起きた時刻** (初回応答日時 / 解決日時 /
//    差し戻し履歴の発生日時) に掛かる。起票日時で切ると窓より長くかかったチケットが
//    平均から丸ごと抜けて「遅いほど数字が良くなる」ため (監査フォローアップ 2026-09-10)。
// 2. **毎リクエストの重い生 SQL**: 3 本の集計クエリ (TicketHistory との JOIN 含む) が
//    ページ表示のたびに走っていた。unstable_cache (60 秒) でラップし、DB 負荷と
//    表示のもたつきを抑える (§8 キャッシュを活用する。通知未読数の 60 秒と同じ方針)。

// Next.js のキャッシュ機構 (同一キーなら一定時間結果を使い回す)
import { unstable_cache } from 'next/cache';
// データ層の Composition Root から品質指標クエリを呼ぶ (Prisma 直叩きを避ける)
import { repos } from '@/data';
// 品質指標の戻り値型 (port の契約)
import type { QualityMetrics } from '@/data/ports/ticket-repository';
// JST の暦日境界 (「直近 N 日」の起点を日単位で安定させる)
import { startOfDayJST } from '@/lib/format-date';

// 品質指標の集計対象期間 (日数)。画面のラベル「直近 30 日」もこの値から組み立てる
// (§6 マジックナンバー禁止: 期間を変えるときはこの 1 か所だけを直す)。
// **README / docs の機能一覧には日数を書かない**（/code-review ultra 指摘対応）:
// 散文に数値を写すと、ここを変えたときに画面と食い違ったまま残る。日数を機械照合する
// 仕組みは無い（tests/doc-body-size-drift.test.ts はバイトサイズ表記しか見ない）ので、
// 一覧側は「直近の移動窓」と書いて実際の日数は画面に語らせている
export const QUALITY_METRICS_WINDOW_DAYS = 30;

// 1 日をミリ秒で表した定数 (期間計算用)
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// キャッシュの有効時間 (秒)。通知未読数 (notifications.ts) と同じ 60 秒に揃える。
// 品質指標は「傾向を見る」数字で秒単位の鮮度は不要なため、60 秒の遅延は許容できる
const QUALITY_METRICS_CACHE_SECONDS = 60;

/**
 * 品質指標の集計起点 (「直近 N 日」の始まり) を返す。
 *
 * 単純な `now - N 日` ではなく **JST の日の始まりに丸めてから** N 日引く。
 * 理由は 2 つ:
 * - 丸めないと起点が毎リクエスト変わり、キャッシュキーが常に別物になって
 *   unstable_cache が一度も効かない (キャッシュ導入の意味が消える)
 * - 「今日を含む直近 30 日」という暦日単位の定義のほうが、利用者にとって
 *   「いつからいつまでの数字か」を説明しやすい
 */
export function qualityMetricsSince(now: Date): Date {
  // JST の今日の始まり (00:00:00.000 +09:00) を求める
  const todayStart = startOfDayJST(now);
  // そこから (窓の日数 - 1) 日ぶん戻す = 「今日を含む直近 N 日」の初日 00:00 (JST)
  return new Date(todayStart.getTime() - (QUALITY_METRICS_WINDOW_DAYS - 1) * ONE_DAY_MS);
}

/**
 * 品質指標を 60 秒キャッシュ付きで取得する (ダッシュボードの「対応品質」セクション用)。
 *
 * キャッシュキーはテナント・拠点・集計起点 (日単位) の組。起点が日単位で安定しているため、
 * 同じテナント・拠点の表示は 1 分間 DB を叩かずに使い回せる。
 * 書き込みに応じた即時無効化は行わない (指標は集計値であり、60 秒の遅延で意思決定が
 * 変わることはないため。厳密さより DB 負荷の低減を優先するトレードオフ)。
 */
export function getCachedQualityMetrics(
  tenantId: string, // テナントスコープ (クロステナント漏洩防止に必須)
  locationId: string | undefined, // 拠点フィルタ (未選択は undefined = 全拠点)
  now: Date, // 現在時刻 (集計起点の計算に使う)
): Promise<QualityMetrics> {
  // 集計起点を日単位で確定する (キャッシュキーの安定化と暦日定義のため)
  const since = qualityMetricsSince(now);
  // unstable_cache は関数引数もキャッシュキーに含めるため、tenantId / locationId / since を
  // 文字列化して渡す (Date を直接渡すと参照ごとに別キー扱いになる実装があるため ISO 文字列にする)
  return unstable_cache(
    // 実際の DB 集計 (port 経由、tenantId スコープ)。sinceIso から Date を復元して渡す
    (tid: string, loc: string, sinceIso: string) =>
      repos.tickets.qualityMetrics({
        tenantId: tid,
        // 'all' は「拠点フィルタなし」の番兵値 (undefined はキーに使えないため文字列で往復する)
        locationId: loc === 'all' ? undefined : loc,
        since: new Date(sinceIso),
      }),
    // キャッシュキーのプレフィックス (通知未読数の 'notification-count' と同じ命名方針)
    ['dashboard-quality-metrics'],
    // 再検証間隔 (秒)。タグ無効化は使わない (上記コメントのとおり時間ベースのみ)
    { revalidate: QUALITY_METRICS_CACHE_SECONDS },
  )(tenantId, locationId ?? 'all', since.toISOString());
}
