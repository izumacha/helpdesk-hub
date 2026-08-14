// リクエスト入口 (proxy) のボディ複製上限が、どの経路の上限も下回らないことを固定するテスト。
//
// なぜテストで縛るのか:
//   Next.js は proxy を持つアプリで、非 GET/HEAD のボディを入口で複製してバッファする。
//   `experimental.proxyClientMaxBodySize` が未設定だと既定 10MB になり、超えた本文は
//   **エラーにならず先頭 10MB で打ち切られたまま**ルートハンドラへ渡る。
//   本リポジトリにはメール取り込み (25MB)・添付付きチケット書き込み (51MB) という
//   10MB を超える経路があり、既定のままだと「大きめの添付だけが 400 になる」形で壊れる。
//   しかも壊れ方が静かなので、E2E (シードデータは小さい) でも表面化しない。
//   だからこそ、振る舞いではなく「入口の枠 ≧ 各経路の枠」という関係を直接固定する。
//
// 何を防ぐか:
//   (a) `next.config.ts` から設定が消える / 別の値に書き換わる退行。
//   (b) どこかの経路の上限を引き上げたのに入口の枠が追随していない状態
//       (導出をやめて直書きに戻した場合に起きる)。

// Vitest の DSL
import { describe, expect, it } from 'vitest';
// 入口の枠と、Next.js の既定値 (設定しないとどうなるかを示すための参照値)
import { ENTRY_MAX_BODY_BYTES, NEXT_DEFAULT_ENTRY_MAX_BODY_BYTES } from '@/lib/entry-body-limit';
// 実際に Next.js へ渡る設定オブジェクト (文字列一致ではなく値そのものを見る)
import nextConfig from '../next.config';
// 経路別の上限。**入口の枠と同じ導出元を再利用せず、各経路の置き場から個別に import する**
// — 導出元ごと import すると「max を取っている」という同じ計算を検算することになり、
// 経路の追加漏れも取りこぼす
import {
  INBOUND_EMAIL_MAX_BODY_BYTES,
  LINE_WEBHOOK_MAX_BODY_BYTES,
  STRIPE_WEBHOOK_MAX_BODY_BYTES,
} from '@/lib/webhook-body-limits';
import {
  ATTACHMENT_UPLOAD_MAX_BODY_BYTES,
  TICKET_JSON_MAX_BODY_BYTES,
} from '@/lib/ticket-body-limits';
import { SSO_ACS_MAX_BODY_BYTES } from '@/lib/sso-rate-limit';
import { MAGIC_LINK_CALLBACK_MAX_BODY_BYTES } from '@/lib/magic-link';

// 経路名と上限の対応表。名前を添えておくと、失敗したときにどの経路が溢れたのかが分かる
const ROUTE_LIMITS: ReadonlyArray<readonly [string, number]> = [
  ['POST /api/inbound/line', LINE_WEBHOOK_MAX_BODY_BYTES],
  ['POST /api/inbound/email', INBOUND_EMAIL_MAX_BODY_BYTES],
  ['POST /api/webhooks/stripe', STRIPE_WEBHOOK_MAX_BODY_BYTES],
  ['POST /api/tickets (multipart)', ATTACHMENT_UPLOAD_MAX_BODY_BYTES],
  ['POST /api/tickets (json)', TICKET_JSON_MAX_BODY_BYTES],
  ['POST /api/auth/sso/[tenantId]/acs', SSO_ACS_MAX_BODY_BYTES],
  ['POST /api/auth/magic-link/callback', MAGIC_LINK_CALLBACK_MAX_BODY_BYTES],
];

describe('入口 (proxy) のボディ複製上限', () => {
  // 経路ごとに 1 ケース立てる (まとめて 1 ケースにすると、失敗時に溢れた経路が特定しづらい)
  it.each(ROUTE_LIMITS)('%s の上限 (%d バイト) を下回らない', (_route, limit) => {
    // 入口の枠が経路の枠以上であることを確認する (下回ると本文が静かに切り詰められる)
    expect(ENTRY_MAX_BODY_BYTES).toBeGreaterThanOrEqual(limit);
  });

  it('Next.js の既定 (10MB) では足りないことを明示する', () => {
    // 既定のままだと 10MB を超える経路が壊れる、という前提そのものを固定しておく。
    // ここが等しくなったら「設定は不要になった」ではなく「上限の構成が変わった」合図で、
    // 上のケースと合わせて設定の要否を見直すことになる
    expect(ENTRY_MAX_BODY_BYTES).toBeGreaterThan(NEXT_DEFAULT_ENTRY_MAX_BODY_BYTES);
  });

  it('next.config.ts が入口の枠をそのまま Next.js へ渡している', () => {
    // 設定漏れ・書き換えを検出する。文字列一致ではなく、実際に export される値を見る
    expect(nextConfig.experimental?.proxyClientMaxBodySize).toBe(ENTRY_MAX_BODY_BYTES);
  });
});
