// ドキュメントの散文に直書きされた「本文サイズの上限」が、コード側の定数とずれていないことを
// 固定するテスト。
//
// なぜテストで縛るのか:
//   入口の枠 (`ENTRY_MAX_BODY_BYTES`) はコードから導出されるが、**それを説明する文章の数値は
//   人が手で写している**。README 冒頭の「添付付きチケット投稿 (51MB) とメール取り込み (25MB)」も
//   `docs/security.md` §7 の散文も同じで、経路上限を引き上げても追随しない。
//   CLAUDE.md はこの状態を既知のギャップとして名指しし、「経路上限を変えたら同じ PR で
//   README の値も更新すること」と書いていた — つまり**追随を人の記憶に頼っていた**。
//
// 何が起きるか (直る方向の間違いではない):
//   古くなった数値は、読んだ人が前段リバースプロキシを設定するときの根拠になる。
//   `MAX_ATTACHMENT_SIZE_BYTES` を倍にすると経路上限は 101MB になるのに、文章は 51MB のままで、
//   その通りに `client_max_body_size 52m` を置くと**上限内の正規リクエストが前段で切られて
//   アプリに届かない**。ブラウザ側には原因の分からない接続断として見え、アプリのログにも
//   残らない (`src/domain/attachment.ts` の事前検査が避けようとしている失敗そのもの)。
//
// **既存の検出網との分担 — コードフェンスの中は見ない。**
//   `tests/entry-body-limit.test.ts` が `docs/security.md` §7 の nginx 設定例
//   (```nginx フェンスの中) の `client_max_body_size` を担当しており、そちらは
//   「経路の上限を下回っていないこと」だけを見て**余裕の取り方 (現状 +1MB) は意図的に固定しない**。
//   ここでフェンスの中まで見て数値を定数へ縛ると、その判断と正面から衝突する
//   (余裕を見直すだけで落ちる変更検知になる)。だから本テストの対象は**フェンスの外の散文だけ**。
//   境界を「フェンスの内/外」という機械的に決まる線に置いているのが要点で、
//   人が「この段落は対象」と選ぶ形にすると選び漏れが検出漏れになる。
//
// **対応関係はドキュメント側に書かせる。**
//   「51MB は `ATTACHMENT_UPLOAD_MAX_BODY_BYTES` のこと」という対応をテスト側の表に写すと、
//   写し間違いがそのまま誤った期待値になり、この検出網が防ぐはずの失敗を自ら招く。
//   そのため各数値の直後に、レンダリングされると消える HTML コメントで出典の定数名を書き、
//   テストはその名前を**実際に import した定数**へ引いて突き合わせる。
//   例: `添付付きチケット投稿（51MB<!--size:ATTACHMENT_UPLOAD_MAX_BODY_BYTES-->）`
//
// 何を防ぐか (いずれも実機で「直す前は落ちる」ことを確認済み):
//   (a) 定数を変えたのに文章の数値が古いまま残る退行。
//   (b) 注記の無いサイズ表記を新しく書き足す (= 検査から漏れる数値が増える) 状態。
//   (c) 注記が存在しない定数名を指している状態 (定数の改名に追随できていない)。
//   (d) ドキュメントの体裁が変わって走査が空振りし、**検査対象ゼロで緑**になる状態。

// Vitest の DSL
import { describe, expect, it } from 'vitest';
// ドキュメントを読むだけなので Node 標準の同期 API で足りる
import { readFileSync } from 'node:fs';
// リポジトリルートからのパス組み立て
import { join } from 'node:path';
// 添付 1 件あたりの上限 (文章が「添付は 10MB まで」と書くときの出典)
import { MAX_ATTACHMENT_SIZE_BYTES } from '@/domain/attachment';
// CSV インポートの上限 (Server Action の枠に収まっていることの説明で使われる)
import { MAX_CSV_BYTES } from '@/lib/csv';
// 入口の枠とその導出材料 (テスト側に値を書き写さず、導出元から受け取る)
import {
  ENTRY_MAX_BODY_BYTES,
  ENTRY_OVER_LIMIT_MARGIN_BYTES,
  ENTRY_OVER_LIMIT_MARGIN_MIN_BYTES,
  NEXT_DEFAULT_ENTRY_MAX_BODY_BYTES,
} from '@/lib/entry-body-limit';
// 未認証で到達できる認証系 2 経路の上限
import { MAGIC_LINK_CALLBACK_MAX_BODY_BYTES, SSO_ACS_MAX_BODY_BYTES } from '@/lib/auth-body-limits';
// 認証済みのチケット書き込み 2 経路の上限
import {
  ATTACHMENT_UPLOAD_MAX_BODY_BYTES,
  TICKET_JSON_MAX_BODY_BYTES,
} from '@/lib/ticket-body-limits';
// 受信 Webhook 3 経路の上限
import {
  INBOUND_EMAIL_MAX_BODY_BYTES,
  LINE_WEBHOOK_MAX_BODY_BYTES,
  STRIPE_WEBHOOK_MAX_BODY_BYTES,
} from '@/lib/webhook-body-limits';

// リポジトリのルート (このテストファイルは <root>/tests/ にあるので 1 つ上)
const REPO_ROOT = join(__dirname, '..');

/**
 * 注記から引ける定数の一覧 (名前 → 現在のバイト数)。
 *
 * **値は書かず、import したものをそのまま並べる。** ここに数値を書くと定義元と二重管理になり、
 * 「テストの期待値だけが古い」= 検査が意味を失った状態に静かに倒れる。
 *
 * **ここに無い名前を注記が指したら落とす** (`unknown-source` 違反)。登録漏れを黙って
 * 素通りさせると、定数を改名したときに「注記は古い名前を指しているのに緑」になり、
 * 対応関係の検査そのものが効かなくなる。新しい定数を文章で引用するときは、
 * ここへ import を 1 行足すだけでよい。
 */
const SIZE_SOURCES: Readonly<Record<string, number>> = {
  // 受信 Webhook 3 経路
  LINE_WEBHOOK_MAX_BODY_BYTES,
  INBOUND_EMAIL_MAX_BODY_BYTES,
  STRIPE_WEBHOOK_MAX_BODY_BYTES,
  // 認証済みのチケット書き込み 2 経路
  ATTACHMENT_UPLOAD_MAX_BODY_BYTES,
  TICKET_JSON_MAX_BODY_BYTES,
  // 未認証で到達できる認証系 2 経路
  SSO_ACS_MAX_BODY_BYTES,
  MAGIC_LINK_CALLBACK_MAX_BODY_BYTES,
  // 入口の枠と、その導出材料
  ENTRY_MAX_BODY_BYTES,
  ENTRY_OVER_LIMIT_MARGIN_BYTES,
  ENTRY_OVER_LIMIT_MARGIN_MIN_BYTES,
  NEXT_DEFAULT_ENTRY_MAX_BODY_BYTES,
  // ドメイン側の上限 (経路上限の導出元でもある)
  MAX_ATTACHMENT_SIZE_BYTES,
  // CSV インポートの上限
  MAX_CSV_BYTES,
};

/**
 * 「この数値は本リポジトリが決めていない」ことを宣言する注記の値。
 *
 * Next.js の `experimental.serverActions.bodySizeLimit` の既定 1MB のように、**上流が持っていて
 * こちらに対応する定数が無い**数値に使う。値の検算はできないが、注記を必須にしておけば
 * 「検査していない数値」が `grep size:upstream` で列挙でき、黙って増えることはない。
 *
 * **抜け穴であることを承知で置いている。** 新しく使われていたらレビューで「本当に上流の値か、
 * 定数に出せないのか」を問うこと。上流の既定でも `NEXT_DEFAULT_ENTRY_MAX_BODY_BYTES` のように
 * 定数として持てるなら、そちらへ寄せる方が望ましい。
 */
const UPSTREAM_MARKER = 'upstream';

/**
 * 散文のサイズ表記で使う単位と倍率。
 *
 * **走査パターンの単位はこの表から作る** (下の `SIZE_TOKEN_PATTERN`)。手書きの選択肢と
 * 二重管理にすると、片方にだけ単位を足したときに「拾えるのに倍率が無い」か
 * 「倍率はあるのに拾えない」のどちらかへ静かに倒れる (後者は検査が緩む方向)。
 */
const SIZE_UNIT_MULTIPLIERS: Readonly<Record<string, number>> = {
  KB: 1024,
  MB: 1024 * 1024,
  GB: 1024 * 1024 * 1024,
};

// 上の表に載っている単位だけを並べた選択肢 (長い単位を先に並べる必要はないが、順序を安定させる)
const SIZE_UNIT_ALTERNATION = Object.keys(SIZE_UNIT_MULTIPLIERS).sort().join('|');

/**
 * 散文中のサイズ表記 (`51MB` / `256KB` / `1.5MB`) を拾うパターン。
 *
 * 数字と単位の間の空白は許す (文章では「10 MB」と書かれることがある)。単位の直後に
 * 英数字が続く場合は拾わない — `10MBps` のような別語を切り出すと、対応する定数が無いのに
 * 注記を要求してしまう。
 */
const SIZE_TOKEN_PATTERN = new RegExp(
  `(\\d+(?:\\.\\d+)?)\\s*(${SIZE_UNIT_ALTERNATION})(?![0-9A-Za-z])`,
  'g',
);

/**
 * サイズ表記の直後に置く出典の注記。
 *
 * **数値の直後に隣接していることを要求する** (間に文字を挟めない)。離れた場所に一覧で書く形は
 * 採らなかった: `1MB` は SSO ACS / Stripe / 入口の余裕のいずれでもありうるので、
 * 表記の文字列だけでは対応が一意に決まらない。
 *
 * 太字の中にある表記は `**1MB<!--size:upstream-->**` のように**閉じ記号の内側**へ置く
 * (隣接の規則を保つため)。HTML コメントは強調の内側でも問題なく無視される。
 *
 * カンマ区切りで複数の定数を書ける。「上限 1MB の経路 (SSO ACS / Stripe)」のように
 * **1 つの数値が複数の経路を指している**場合に使い、書いた全部が同じ値であることを要求する
 * (片方だけ変わったときに文章が黙って嘘になるのを防ぐ)。
 */
const SIZE_MARKER_PATTERN = /^<!--size:([A-Za-z0-9_,\s]+)-->/;

// コードフェンスの開始・終了行 (``` で始まる行)。中身は本テストの対象外にする
const CODE_FENCE_PATTERN = /^\s*```/;

/**
 * 検査対象のドキュメント。
 *
 * **リポジトリからの相対パスで持つ**ので、ファイルを移動したら `readFileSync` が例外を投げて
 * 落ちる (パスが消えたのに緑、という状態を作らない)。
 */
const TARGET_DOCS = ['README.md', join('docs', 'security.md')] as const;

/**
 * ドキュメントを読み、コードフェンスの中身を空行に置き換えた行配列を返す。
 *
 * **行を削らずに空にする**のが要点で、こうしておけば違反メッセージに出す行番号が
 * 実ファイルとずれない (ずれた行番号は、直す人を無関係な箇所へ案内してしまう)。
 */
function readProseLines(relativePath: string): string[] {
  // ドキュメント全体を読む (存在しなければここで例外になり、テストは落ちる)
  const raw = readFileSync(join(REPO_ROOT, relativePath), 'utf8');
  // いまフェンスの内側にいるか
  let insideFence = false;
  // 1 行ずつ見て、フェンスの内側なら空行に置き換える
  return raw.split('\n').map((line) => {
    // フェンスの境界行そのものも対象外にする (``` の行に数値は書かない)
    if (CODE_FENCE_PATTERN.test(line)) {
      // 境界を跨いだので内外を反転させる
      insideFence = !insideFence;
      // 境界行自体は空扱い
      return '';
    }
    // フェンスの内側は空行、外側はそのまま返す
    return insideFence ? '' : line;
  });
}

/**
 * バイト数を、散文で使う表記 (`51MB` / `256KB`) に直して返す。
 *
 * 違反メッセージに「では正しくは何と書くべきか」を載せるために使う。割り切れない場合は
 * 単位に丸めず**バイト数のまま**返す — 丸めた値を提示すると、その通りに直したのに
 * 次回また落ちる (丸め後の数値は定数と一致しない) ため。
 */
function formatBytes(bytes: number): string {
  // 大きい単位から順に、割り切れる単位を探す
  for (const [unit, multiplier] of Object.entries(SIZE_UNIT_MULTIPLIERS).sort(
    (a, b) => b[1] - a[1],
  )) {
    // 割り切れるならその単位で表記する
    if (bytes % multiplier === 0) return `${bytes / multiplier}${unit}`;
  }
  // どの単位でも割り切れないならバイト数をそのまま出す
  return `${bytes} バイト`;
}

// 走査で見つけた 1 件のサイズ表記
interface SizeMention {
  // 実ファイル上の行番号 (1 始まり)
  line: number;
  // 表記そのもの (例: `51MB`)
  token: string;
  // 表記が表しているバイト数
  bytes: number;
  // 直後の注記に書かれていた内容 (注記が無ければ undefined)
  marker: string | undefined;
}

/**
 * ドキュメントの散文から、サイズ表記とその直後の注記を拾って返す。
 *
 * **判定はしない — 拾うだけ。** 違反を挙げるのは `driftOffenders()` の仕事で、ここはその入力を作る。
 */
function collectSizeMentions(relativePath: string): SizeMention[] {
  // 拾った表記を溜める入れ物
  const mentions: SizeMention[] = [];
  // フェンスを除いた散文を 1 行ずつ見る
  readProseLines(relativePath).forEach((line, index) => {
    // 行内のすべてのサイズ表記を順に拾う (グローバル指定の正規表現を使い回すため lastIndex を戻す)
    SIZE_TOKEN_PATTERN.lastIndex = 0;
    // 1 件ずつ取り出す
    let match: RegExpExecArray | null;
    while ((match = SIZE_TOKEN_PATTERN.exec(line)) !== null) {
      // 数値部分を取り出す
      const amount = Number(match[1]);
      // 単位を倍率に直す (単位は表から作った選択肢でしか一致しないので必ず引ける)
      const multiplier = SIZE_UNIT_MULTIPLIERS[match[2]];
      // 表記の直後の文字列を切り出し、注記が隣接しているかを見る
      const marker = line.slice(match.index + match[0].length).match(SIZE_MARKER_PATTERN);
      // 1 件として記録する (注記が無ければ undefined のまま持たせ、違反判定はあとで行う)
      mentions.push({
        line: index + 1,
        token: match[0],
        bytes: amount * multiplier,
        marker: marker ? marker[1].trim() : undefined,
      });
    }
  });
  // 拾った一覧を返す
  return mentions;
}

/**
 * ドキュメント 1 つぶんの違反を返す (空なら、散文の数値がすべて定数と一致している)。
 *
 * 違反の種類は 3 つで、いずれも**検査が緩む方向へ倒れない**ようにするためのもの:
 *   - `注記がありません` … 出典を書かずに数値を足した (その数値が検査から漏れる)。
 *   - `定数がありません` … 注記が `SIZE_SOURCES` に無い名前を指している (改名に追随していない)。
 *   - 値の不一致 … 文章の数値が定数の現在値と違う (本テストの主眼)。
 */
function driftOffenders(relativePath: string): string[] {
  // 違反を溜める入れ物
  const offenders: string[] = [];
  // 拾った表記を 1 件ずつ検査する
  for (const mention of collectSizeMentions(relativePath)) {
    // 違反メッセージの先頭に付ける位置情報 (どこを直せばよいか分かるように)
    const where = `${relativePath}:${mention.line} の ${mention.token}`;
    // 注記が無ければ、その数値は検査できないので違反にする
    if (mention.marker === undefined) {
      offenders.push(`${where}: 出典の注記 <!--size:定数名--> がありません`);
      continue;
    }
    // 上流が持つ値だと宣言されているなら、値の検算はしない (注記の存在だけを要求する)
    if (mention.marker === UPSTREAM_MARKER) continue;
    // カンマ区切りの定数名を 1 つずつ検査する (空要素は書き間違いなので落とす)
    for (const name of mention.marker.split(',').map((part) => part.trim())) {
      // 名前が空なら注記の書き間違い (例: `A,,B` / 末尾のカンマ)
      if (name === '') {
        offenders.push(`${where}: 注記 '${mention.marker}' に空の定数名があります`);
        continue;
      }
      // 登録されていない名前なら、突き合わせる相手が無いので違反にする
      if (!(name in SIZE_SOURCES)) {
        offenders.push(
          `${where}: 注記が指す ${name} が SIZE_SOURCES にありません ` +
            '(定数を改名したか、テスト側の import を足し忘れている)',
        );
        continue;
      }
      // 定数の現在値を引く
      const expected = SIZE_SOURCES[name];
      // 文章の数値と一致しなければ違反にする (正しい表記も添えてそのまま直せるようにする)
      if (expected !== mention.bytes) {
        offenders.push(
          `${where}: ${name} は ${formatBytes(expected)} (${expected} バイト) なので、` +
            `文章を ${formatBytes(expected)} に直すこと`,
        );
      }
    }
  }
  // 失敗時のメッセージを安定させるため並べ替えて返す
  return offenders.sort();
}

describe('ドキュメントの本文サイズ表記', () => {
  // ドキュメントごとに同じ検査を回す (対象を足すときは TARGET_DOCS へ 1 行足すだけでよい)
  for (const relativePath of TARGET_DOCS) {
    it(`${relativePath} の散文のサイズ表記が定数の現在値と一致している`, () => {
      // 違反が 1 件も無いことを要求する (メッセージに全件が出るので一度に直せる)
      expect(driftOffenders(relativePath)).toEqual([]);
    });

    it(`${relativePath} に検査対象のサイズ表記が存在する`, () => {
      // 体裁の変更で走査が空振りしていないことを確かめる。
      // **これが無いと「対象ゼロで緑」に静かに倒れる** — 上の検査は違反ゼロを見るだけなので、
      // 表記を 1 つも拾えなくなった状態と、全部が正しい状態を区別できない
      const mentions = collectSizeMentions(relativePath);
      // 少なくとも 1 件は拾えていること
      expect(mentions.length).toBeGreaterThan(0);
      // そのうち少なくとも 1 件は定数と突き合わせていること
      // (全件が upstream 宣言に置き換わると、実質的に何も検算しなくなる)
      expect(
        mentions.filter((m) => m.marker !== undefined && m.marker !== UPSTREAM_MARKER).length,
      ).toBeGreaterThan(0);
    });
  }

  it('SIZE_SOURCES の値がすべて正の有限な数である', () => {
    // 定数が undefined や NaN のまま入ると、比較が常に不一致 (または常に一致) になり
    // 検査の意味が失われる。import の取り違えをここで落とす
    for (const [name, bytes] of Object.entries(SIZE_SOURCES)) {
      // 有限な数であること
      expect(Number.isFinite(bytes), `${name} が有限な数ではない`).toBe(true);
      // 正の値であること
      expect(bytes, `${name} が正の値ではない`).toBeGreaterThan(0);
    }
  });

  it('注記の無いサイズ表記を足すと落ちる', () => {
    // 検出網が「注記の無い数値」を実際に拾えることを、走査部分の単体で確かめる。
    // ドキュメント本体を書き換えずに済むよう、同じ判定を通す最小の入力で検算する
    const withoutMarker = 'メール取り込み（25MB）を受け付ける';
    // 表記は拾えるが注記が無い状態になること
    SIZE_TOKEN_PATTERN.lastIndex = 0;
    const match = SIZE_TOKEN_PATTERN.exec(withoutMarker);
    // 表記そのものは拾えること
    expect(match?.[0]).toBe('25MB');
    // 直後に注記が無いこと (= 上の driftOffenders が違反として報告する状態)
    expect(
      withoutMarker
        .slice((match?.index ?? 0) + (match?.[0].length ?? 0))
        .match(SIZE_MARKER_PATTERN),
    ).toBeNull();
  });

  it('コードフェンスの中身は対象外になる', () => {
    // nginx 設定例の値は `tests/entry-body-limit.test.ts` の担当で、
    // あちらは余裕の取り方を意図的に固定しない。ここで拾ってしまうとその判断と衝突するため、
    // フェンス除去が効いていることを固定する
    const lines = readProseLines(join('docs', 'security.md'));
    // **目印はフェンス内にしか無い文字列を選ぶ。** 「経路の上限」や `client_max_body_size` は
    // 散文にも出てくるので、それを目印にすると除去が効いていなくても消えたように見えてしまう
    // (実際に一度そうなった。目印の選び間違いは検査を無意味にする方向の失敗)。
    // ここではフェンス内の nginx コメントを使う — **これ自体がサイズ表記を含む**ので、
    // 除去が効いていなければ上の検査が「注記の無い表記」として落ちる関係にある
    expect(lines.some((line) => line.includes('経路の上限 51MB + 1MB'))).toBe(false);
    // 転送設定の指令もフェンス内にしか無いので、併せて消えていることを見る
    expect(lines.some((line) => line.includes('include proxy_params'))).toBe(false);
    // 一方でフェンス外の散文は残っていること (除去が行き過ぎていないことの確認)
    expect(lines.some((line) => line.includes('入口の枠を経路の最大値に合わせている理由'))).toBe(
      true,
    );
  });
});
