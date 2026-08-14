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
//   (c) 新しい経路の上限を足したのに `ROUTE_MAX_BODY_BYTES` へ登録し忘れた状態
//       (登録が人手の約束のままだと、静かな切り詰めがそのまま再発する)。

// Vitest の DSL
import { describe, expect, it } from 'vitest';
// ソースを走査して「上限の定義漏れ」を拾うため (Node 標準の同期 API で十分)
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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

// リポジトリのルート (このテストファイルは <root>/tests/ にあるので 1 つ上)
const REPO_ROOT = join(__dirname, '..');
// 走査対象のソースディレクトリ
const SRC_DIR = join(REPO_ROOT, 'src');
// 導出元 (この一覧に登録されていない上限を落としたい)
const ENTRY_MODULE_PATH = join(SRC_DIR, 'lib', 'entry-body-limit.ts');
// 経路上限の命名規約。この名前で export されたものを「経路の上限」とみなす
const ROUTE_LIMIT_EXPORT_PATTERN = /^export const ([A-Z0-9_]*_MAX_BODY_BYTES)\b/gm;

/**
 * `src/` 配下で `*_MAX_BODY_BYTES` として export されているのに、
 * `ROUTE_MAX_BODY_BYTES` へ登録されていない定数名を返す (空なら登録漏れ無し)。
 *
 * 値ではなく**名前**を突き合わせるのは、各モジュールを動的 import すると
 * 将来重い依存 (Prisma 等) を持つモジュールが混ざったときにテストごと巻き添えになるため。
 */
function unregisteredRouteLimitNames(): string[] {
  // 導出元のソース。この中に名前が現れていれば「登録済み」とみなす
  const entrySource = readFileSync(ENTRY_MODULE_PATH, 'utf8');
  // 導出元自身が export する枠 (ENTRY_MAX_BODY_BYTES 等) は経路の上限ではないので除外する
  const ownExports = [...entrySource.matchAll(ROUTE_LIMIT_EXPORT_PATTERN)].map((m) => m[1]);
  // src/ 配下の .ts を再帰的に集める (生成物は対象外)
  const files = readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
    .filter((rel) => rel.endsWith('.ts') && !rel.startsWith('generated'))
    .map((rel) => join(SRC_DIR, rel));
  // 登録漏れの定数名を溜める入れ物
  const missing: string[] = [];
  // 1 ファイルずつ、経路上限の export を拾って登録状況を見る
  for (const file of files) {
    // ファイルの中身を文字列として読む
    const source = readFileSync(file, 'utf8');
    // 命名規約に合う export をすべて拾う
    for (const match of source.matchAll(ROUTE_LIMIT_EXPORT_PATTERN)) {
      // 拾った定数名
      const name = match[1];
      // 導出元自身の export は経路の上限ではないので飛ばす
      if (ownExports.includes(name)) continue;
      // 導出元のソースに名前が出てこなければ登録漏れ
      if (!entrySource.includes(name)) missing.push(name);
    }
  }
  // 失敗時のメッセージを安定させるため並べ替えて返す
  return missing.sort();
}

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

  it('src/ 配下の経路上限がすべて ROUTE_MAX_BODY_BYTES に登録されている', () => {
    // 導出元の一覧に載っていない上限があると、その経路だけ入口で切り詰められる。
    // 「足したら登録する」を人手の約束にせず、ここで機械的に落とす
    expect(unregisteredRouteLimitNames()).toEqual([]);
  });
});
