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
import {
  ENTRY_MAX_BODY_BYTES,
  ENTRY_OVER_LIMIT_MARGIN_MIN_BYTES,
  NEXT_DEFAULT_ENTRY_MAX_BODY_BYTES,
} from '@/lib/entry-body-limit';
// 実際に Next.js へ渡る設定オブジェクト (文字列一致ではなく値そのものを見る)
import nextConfig from '../next.config';
// 経路別の上限。導出元 (`ROUTE_MAX_BODY_BYTES`) を再利用せず各経路の置き場から個別に import する
// のは、**この対応表そのものを「今どの経路にいくつの枠があるか」の読める一覧として残す**ため。
// 検出力の分担は下の describe を参照 (登録漏れの検出はこの表ではなく完全性テストが担う)
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
// 経路上限の命名規約。この名前で export されたものを「経路の上限」とみなす。
// **`*_MAX_BODY_BYTES` という命名に乗っていることが検出の前提**で、`MAX_UPLOAD_BYTES` のように
// 規約から外れた名前は拾えない (拾えないと入口の枠が追随せず、静かな切り詰めが戻る)。
// 新しい経路上限はこの命名に揃えること。
const ROUTE_LIMIT_DECLARATION_PATTERN = /^export const ([A-Z0-9_]*_MAX_BODY_BYTES)\b/gm;
// 宣言と分けて公開する形 (`export { FOO_MAX_BODY_BYTES }` / バレル経由の再 export) も拾う。
// 宣言だけを見ていると、この形で足された上限が検出網を素通りする
const ROUTE_LIMIT_EXPORT_BLOCK_PATTERN = /export\s*\{([^}]*)\}/g;
// export ブロックの中に並ぶ名前のうち、経路上限の命名に合うもの
const ROUTE_LIMIT_NAME_PATTERN = /\b([A-Z0-9_]*_MAX_BODY_BYTES)\b/g;

/**
 * 1 ファイルのソースから、経路上限として公開されている定数名をすべて拾う。
 *
 * 宣言 (`export const X = ...`) と、宣言と分けた公開 (`export { X }`) の 2 形式を見る。
 * 同じ名前が両方で出てくることがあるので呼び出し側で重複を許す前提にしてある。
 */
function exportedRouteLimitNames(source: string): string[] {
  // 宣言形式で公開されている名前
  const declared = [...source.matchAll(ROUTE_LIMIT_DECLARATION_PATTERN)].map((m) => m[1]);
  // export ブロック形式で公開されている名前 (ブロックの中身だけを対象にする)
  const reExported = [...source.matchAll(ROUTE_LIMIT_EXPORT_BLOCK_PATTERN)].flatMap((block) =>
    [...block[1].matchAll(ROUTE_LIMIT_NAME_PATTERN)].map((m) => m[1]),
  );
  // 両方をまとめて返す
  return [...declared, ...reExported];
}
// 導出元の一覧 (`const ROUTE_MAX_BODY_BYTES = [ ... ] as const;`) を切り出すためのパターン
const REGISTRY_BLOCK_PATTERN = /const ROUTE_MAX_BODY_BYTES = \[([\s\S]*?)\] as const;/;
// 一覧の中に 1 行ずつ並ぶ定数名 (末尾のカンマまでを 1 要素とみなす)
const REGISTRY_ENTRY_PATTERN = /^\s*([A-Z0-9_]+),/gm;

/**
 * 導出元の `ROUTE_MAX_BODY_BYTES` に**実際に登録されている**定数名を返す。
 *
 * ソース全体への部分一致ではなく配列の中身だけを見るのが要点。全体一致にすると
 * (a) 既存名の部分文字列 (`EMAIL_MAX_BODY_BYTES` が `INBOUND_EMAIL_MAX_BODY_BYTES` に一致) や
 * (b) コメント中に名前が出てくるだけ、でも「登録済み」と誤判定してしまい、
 * 下の登録漏れ検出がすり抜ける (どちらも実際にすり抜けることを確認済み)。
 */
function registeredRouteLimitNames(entrySource: string): string[] {
  // 配列リテラルの中身だけを切り出す
  const block = entrySource.match(REGISTRY_BLOCK_PATTERN);
  // 一覧そのものが見つからない = 導出の形が変わったということなので、登録ゼロとして落とす
  if (!block) return [];
  // 各行の先頭に並ぶ定数名を拾う
  return [...block[1].matchAll(REGISTRY_ENTRY_PATTERN)].map((m) => m[1]);
}

/**
 * `src/` 配下で `*_MAX_BODY_BYTES` として export されているのに、
 * `ROUTE_MAX_BODY_BYTES` へ登録されていない定数名を返す (空なら登録漏れ無し)。
 *
 * 値ではなく**名前**を突き合わせるのは、各モジュールを動的 import すると
 * 将来重い依存 (Prisma 等) を持つモジュールが混ざったときにテストごと巻き添えになるため。
 */
function unregisteredRouteLimitNames(): string[] {
  // 導出元のソース
  const entrySource = readFileSync(ENTRY_MODULE_PATH, 'utf8');
  // 導出元自身が export する枠 (ENTRY_MAX_BODY_BYTES 等) は経路の上限ではないので除外する
  const ownExports = exportedRouteLimitNames(entrySource);
  // 一覧に登録済みの定数名 (完全一致で突き合わせる)
  const registered = registeredRouteLimitNames(entrySource);
  // src/ 配下の .ts / .tsx を再帰的に集める (生成物は対象外)。
  // .tsx も見るのは、上限がコンポーネント側 (フォームの事前検査など) に置かれても
  // 検出網から外れないようにするため
  const files = readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
    .filter((rel) => (rel.endsWith('.ts') || rel.endsWith('.tsx')) && !rel.startsWith('generated'))
    .map((rel) => join(SRC_DIR, rel));
  // 登録漏れの定数名を溜める入れ物 (同じ名前を 2 度報告しないよう集合で持つ)
  const missing = new Set<string>();
  // 1 ファイルずつ、経路上限の export を拾って登録状況を見る
  for (const file of files) {
    // ファイルの中身を文字列として読む
    const source = readFileSync(file, 'utf8');
    // 命名規約に合う export をすべて拾う (宣言形式・export ブロック形式の両方)
    for (const name of exportedRouteLimitNames(source)) {
      // 導出元自身の export は経路の上限ではないので飛ばす
      if (ownExports.includes(name)) continue;
      // 一覧に完全一致で載っていなければ登録漏れ
      if (!registered.includes(name)) missing.add(name);
    }
  }
  // 失敗時のメッセージを安定させるため並べ替えて返す
  return [...missing].sort();
}

describe('入口 (proxy) のボディ複製上限', () => {
  // 経路ごとに 1 ケース立てる (まとめて 1 ケースにすると、失敗時に溢れた経路が特定しづらい)。
  //
  // **現在の導出 (`max(登録済み) + 余白`) のもとでは、この 7 ケースは恒真である。**
  // 同じ 7 定数から max を取っているので下回りようがない。それでも残しているのは
  // 「導出のしかたが変わったとき」に効かせるため — 例えば誰かが `ENTRY_MAX_BODY_BYTES` を
  // 直書きの数値に戻せば、その値が小さい経路をここが名指しで落とす。
  // 逆に、**登録漏れ (この表に現れない新経路) はここでは絶対に捕まらない**。それは下の
  // 完全性テストの担当で、両者は守備範囲が違う (片方があれば足りる関係ではない)。
  it.each(ROUTE_LIMITS)('%s の上限 (%d バイト) を下回らない', (_route, limit) => {
    // 入口の枠が経路の枠以上であることを確認する (下回ると本文が静かに切り詰められる)
    expect(ENTRY_MAX_BODY_BYTES).toBeGreaterThanOrEqual(limit);
  });

  it('最大の経路上限に対して、超過を観測できるだけの余白を残している', () => {
    // 経路別上限の最大値 (入口の枠はこれを基準に余白を足したものになる)
    const largestRouteLimit = Math.max(...ROUTE_LIMITS.map(([, limit]) => limit));
    // 余白が消えると「入口の枠 ≧ 各経路の枠」は成立したままなのに、ルート側が上限超過を
    // 観測できなくなり 413 が返せなくなる (chunked 転送の超過が 400 に化ける)。
    // 経路ごとの比較では捕まえられない退行なので、余白そのものをここで固定する
    expect(ENTRY_MAX_BODY_BYTES - largestRouteLimit).toBeGreaterThanOrEqual(
      ENTRY_OVER_LIMIT_MARGIN_MIN_BYTES,
    );
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
