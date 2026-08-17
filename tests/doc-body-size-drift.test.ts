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
//   「経路の上限を下回っていないこと」だけを見て**上乗せする余裕の大きさは意図的に固定しない**。
//   ここでフェンスの中まで見て数値を定数へ縛ると、その判断と正面から衝突する
//   (余裕を見直すだけで落ちる変更検知になる)。だから本テストの対象は**フェンスの外の散文だけ**。
//   境界を「フェンスの内/外」という機械的に決まる線に置いているのが要点で、
//   人が「この段落は対象」と選ぶ形にすると選び漏れが検出漏れになる。
//
//   **その代わり、散文には nginx 形式のサイズ表記 (`2m` / `52m`) を書かない。** 単位表
//   (`SIZE_UNIT_MULTIPLIERS`) は `KB` / `MB` / `GB` / `バイト` しか持たないので、小文字サフィックス
//   は表記として拾えず、注記も要求できない = この検出網の外に落ちる。フェンス内の設定例が
//   その値の正本なので、散文からは数値を消して設定例を参照させる (以前 §7 の末尾に
//   「既定の 2m を継承する」と書かれていて、実際に両テストの隙間へ落ちていた)。
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
//   (e) 注記だけが残り、直前の数値を表記として拾えていない状態 (= 注記が宙に浮き、
//       検査したつもりで何も検査していない)。桁区切り (`1,256KB`) や単位の書き換えで起きる。
//
// **検査の本体を通してテストする。** (b) や (c) の「落ちること」を、判定ロジックを
// テスト側に写して確かめる形にはしない — 本体の分岐を削っても写しの方は通るので、
// 番人に見えて何も守らないテストになる (実際に一度その形で書き、本体から分岐を消しても
// 緑のままであることを確認した)。走査と判定は行配列を受ける純粋関数として切り出し、
// ファイル読み込みは薄い包みに寄せてある。

// Vitest の DSL
import { describe, expect, it } from 'vitest';
// ドキュメントを読むだけなので Node 標準の同期 API で足りる
import { readFileSync } from 'node:fs';
// リポジトリルートからのパス組み立て
import { join } from 'node:path';
// 添付 1 件あたりの上限 (docs/overview.md が「10MB 上限」と書くときの出典)
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
 * **ここに無い名前を注記が指したら落とす。** 登録漏れを黙って素通りさせると、定数を改名した
 * ときに「注記は古い名前を指しているのに緑」になり、対応関係の検査そのものが効かなくなる。
 * 新しい定数を文章で引用するときは、ここへ import を 1 行足すだけでよい。
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
 * **走査パターンの単位はこの表から作る** (下の `SIZE_TOKEN_SOURCE`)。手書きの選択肢と
 * 二重管理にすると、片方にだけ単位を足したときに「拾えるのに倍率が無い」か
 * 「倍率はあるのに拾えない」のどちらかへ静かに倒れる (後者は検査が緩む方向)。
 *
 * **`バイト` を含めているのは、違反メッセージが提示する表記を必ず拾えるようにするため。**
 * `formatBytes` は単位で割り切れない値をバイト数のまま案内するので、`バイト` を拾えないと
 * 「案内どおり直した瞬間その数値が無検査になる」経路ができてしまう (検出網が自らの案内で
 * 被覆を失う)。1024 で割り切れない上限を将来導入したときに効く。
 *
 * **nginx 形式の小文字サフィックス (`2m` / `52m`) は意図的に入れない。** あれはフェンス内の
 * 設定例の書式で、そちらは `tests/entry-body-limit.test.ts` の担当。散文には書かない規則に
 * してある (ファイル冒頭の「分担」参照)。ここへ足すと、余裕の大きさを固定しないという
 * あちらの判断と衝突する。
 */
const SIZE_UNIT_MULTIPLIERS: Readonly<Record<string, number>> = {
  KB: 1024,
  MB: 1024 * 1024,
  GB: 1024 * 1024 * 1024,
  バイト: 1,
};

// 上の表に載っている単位だけを並べた選択肢 (順序を安定させるため並べ替える)
const SIZE_UNIT_ALTERNATION = Object.keys(SIZE_UNIT_MULTIPLIERS).sort().join('|');

/**
 * 散文中のサイズ表記 (`51MB` / `256KB` / `1.5MB` / `524288 バイト`) を拾うパターンの元になる文字列。
 *
 * **走査用 (グローバル) と、末尾一致用の 2 通りに使い回すので、素の文字列で持つ。** 2 本を別々に
 * 書くと片方だけ直したときに「走査は拾うのに末尾一致は外れる」= 注記の宙浮き検査 (下の
 * `orphanMarkerOffenders`) が黙って効かなくなる。
 *
 * 数字と単位の間の空白は許す (文章では「10 MB」「524288 バイト」と書かれる)。
 *
 * **桁区切りのカンマを数値の一部として受ける** のが要点。受けないと `1,256KB` が末尾の
 * `256KB` だけ切り出され、文章が約 5 倍の値を書いているのに定数と一致して**通ってしまう**
 * (実機で再現した)。カンマを含めて拾えば 1256KB として比較され、loud に落ちる。
 *
 * 左側の境界 `(?<![\d.,])` は、数値の途中から拾い始めないための歯止め。単位の直後に
 * 英数字が続く場合は拾わない — `10MBps` のような別語を切り出すと、対応する定数が無いのに
 * 注記を要求してしまう。
 */
const SIZE_TOKEN_SOURCE = `(?<![\\d.,])(\\d+(?:,\\d{3})*(?:\\.\\d+)?)\\s*(${SIZE_UNIT_ALTERNATION})(?![0-9A-Za-z])`;

// 行内のサイズ表記を順に拾うための走査パターン (毎回 lastIndex を戻して使う)
const SIZE_TOKEN_PATTERN = new RegExp(SIZE_TOKEN_SOURCE, 'g');

// 「ある位置の直前がサイズ表記で終わっているか」を見るためのパターン (注記の宙浮き検査に使う)
const SIZE_TOKEN_AT_END_PATTERN = new RegExp(`${SIZE_TOKEN_SOURCE}$`);

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

// 行内の注記を位置ごとに拾うための走査パターン (宙浮き検査で使う)
const SIZE_MARKER_ANYWHERE_PATTERN = /<!--size:([A-Za-z0-9_,\s]+)-->/g;

/**
 * nginx 形式の小文字サフィックスによるサイズ表記 (`2m` / `52m` / `128k`) を拾うパターン。
 *
 * **散文でこの書式を使うことを禁じるために持つ。** 単位表に無い書式なので表記として拾えず、
 * 注記も要求できないため、放っておくと両テストの隙間に落ちる。実際に §7 の末尾へ
 * 「足さなければ既定の 2m を継承する」と書かれていて、設定例の既定値を変えても
 * どちらのテストも落ちない状態になっていた (前段プロキシの設定根拠になる数値なので、
 * 古いまま残ると上限内の正規リクエストが前段で切られる)。
 *
 * **「書かない」を文章の約束にせず、ここで機械的に落とす。** 注記付きなら宙浮き検査が拾うが、
 * 注記を付けずに書かれた場合はそれも働かないため、書式そのものを禁じる必要がある。
 *
 * 大文字は対象外 (`10MB` の `MB` を誤って拾わないため)。後ろに英数字が続く場合も除く
 * (`30s` のような別の単位や、識別子の一部を拾わないため)。
 */
const NGINX_STYLE_SIZE_PATTERN = /(?<![\d.,])\d+(?:\.\d+)?\s*[kmg](?![0-9A-Za-z])/g;

// コードフェンスの開始・終了行 (``` で始まる行)。中身は本テストの対象外にする
const CODE_FENCE_PATTERN = /^\s*```/;

/**
 * 検査対象のドキュメント (リポジトリルートからの相対パス)。
 *
 * ファイルを移動したら `readFileSync` が例外を投げて落ちる (パスが消えたのに緑、という状態を
 * 作らない)。
 *
 * **`CLAUDE.md` を入れていない理由。** あちらにも本文サイズの説明はあるが、§15「見せ方」以降は
 * 原本テンプレート `izumacha/claude-code-rules` と同期する領域で、そこに含まれる
 * 「デモ GIF は 10MB 以下」はコードの定数と無関係な運用上の目安である。注記を入れると原本との
 * 差分になり、勝手に書き換えない規則に反する。代わりに **§3 側から本文サイズの数値そのものを
 * 消し**、定数名で参照する形にしてある (数値が無ければ古くなりようがない)。
 * `CLAUDE.md` に本文サイズの数値を書き戻すなら、同時にこの一覧へ足すこと。
 */
const TARGET_DOCS = [
  'README.md',
  join('docs', 'security.md'),
  join('docs', 'overview.md'),
] as const;

/**
 * Markdown 本文から、コードフェンスの中身を空行に置き換えた行配列を返す。
 *
 * **行を削らずに空にする**のが要点で、こうしておけば違反メッセージに出す行番号が
 * 実ファイルとずれない (ずれた行番号は、直す人を無関係な箇所へ案内してしまう)。
 *
 * ファイル読み込みを含めないのは、判定の本体をテストから直接呼べるようにするため
 * (ファイル入出力と混ぜると、合成した入力で本体を検算できなくなる)。
 */
function stripFencedLines(raw: string): string[] {
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
 * ドキュメントを読み、コードフェンスを除いた散文の行配列を返す薄い包み。
 */
function readProseLines(relativePath: string): string[] {
  // ファイル全体を読んでフェンスを落とす (存在しなければここで例外になり、テストは落ちる)
  return stripFencedLines(readFileSync(join(REPO_ROOT, relativePath), 'utf8'));
}

/**
 * 表記の数値部分 (`1,256` のような桁区切りを含む) をバイト数に直して返す。
 */
function parseAmount(rawAmount: string, unit: string): number {
  // 桁区切りのカンマを外してから数値化する (`1,256` → 1256)
  const amount = Number(rawAmount.replace(/,/g, ''));
  // 単位を倍率に直して掛ける (単位は表から作った選択肢でしか一致しないので必ず引ける)
  return amount * SIZE_UNIT_MULTIPLIERS[unit];
}

/**
 * バイト数を、散文で使う表記 (`51MB` / `256KB`) に直して返す。
 *
 * 違反メッセージに「では正しくは何と書くべきか」を載せるために使う。割り切れない場合は
 * 単位に丸めず**バイト数のまま**返す — 丸めた値を提示すると、その通りに直したのに
 * 次回また落ちる (丸め後の数値は定数と一致しない) ため。`バイト` も単位表に入れてあるので、
 * この案内どおりに直した表記もそのまま検査対象になる。
 */
function formatBytes(bytes: number): string {
  // 大きい単位から順に、割り切れる単位を探す
  for (const [unit, multiplier] of Object.entries(SIZE_UNIT_MULTIPLIERS).sort(
    (a, b) => b[1] - a[1],
  )) {
    // 割り切れるならその単位で表記する (バイトは倍率 1 なので必ず最後に一致する)
    if (bytes % multiplier === 0) return `${bytes / multiplier}${unit}`;
  }
  // 単位表に倍率 1 が無くなった場合の保険 (通常ここには来ない)
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
 * 散文の行配列から、サイズ表記とその直後の注記を拾って返す。
 *
 * **判定はしない — 拾うだけ。** 違反を挙げるのは `driftOffendersIn()` の仕事で、
 * ここはその入力を作る。
 */
function collectSizeMentions(lines: string[]): SizeMention[] {
  // 拾った表記を溜める入れ物
  const mentions: SizeMention[] = [];
  // 1 行ずつ見る
  lines.forEach((line, index) => {
    // 行内のすべてのサイズ表記を順に拾う (走査パターンを使い回すため lastIndex を戻す)
    SIZE_TOKEN_PATTERN.lastIndex = 0;
    // 1 件ずつ取り出す
    let match: RegExpExecArray | null;
    while ((match = SIZE_TOKEN_PATTERN.exec(line)) !== null) {
      // 表記の直後の文字列を切り出し、注記が隣接しているかを見る
      const marker = line.slice(match.index + match[0].length).match(SIZE_MARKER_PATTERN);
      // 1 件として記録する (注記が無ければ undefined のまま持たせ、違反判定はあとで行う)
      mentions.push({
        line: index + 1,
        token: match[0],
        bytes: parseAmount(match[1], match[2]),
        marker: marker ? marker[1].trim() : undefined,
      });
    }
  });
  // 拾った一覧を返す
  return mentions;
}

/**
 * 直前の数値を表記として拾えていない注記 (= 宙に浮いた注記) を違反として返す。
 *
 * **これが無いと、表記を拾えなくなる向きの退行が「違反ゼロで緑」になる。** 注記を書いた本人は
 * 検査されているつもりでいるので、気付く手掛かりが無い。実際に踏みうる形は 2 つ:
 *   - 桁区切りや単位の書き換えで走査パターンから外れた (`1,256KB` を数値の一部として
 *     受けられなかった頃はこれで素通りした)。
 *   - 単位表から単位を消した / 表記を別の書式へ直した。
 *
 * 判定は「注記の開始位置までの文字列が、サイズ表記で終わっているか」だけ。走査パターンと
 * 同じ元文字列から作った末尾一致パターンを使うので、2 本の食い違いは起きない。
 *
 * **例外を作っていない** (インラインコード内などを除外しない) 点に注意。そのため文章の中で
 * 注記の書式を説明するときは、実在する定数名を書かずに `<数値><!--size:定数名-->` のような
 * プレースホルダで書くこと (日本語のプレースホルダは注記のパターンに一致しないので拾われない)。
 * 除外規則を足すと「除外された場所に本物の注記を書いても検査されない」穴になるため、
 * 厳しい側に倒したまま、書き方の規則で回避する。
 */
function orphanMarkerOffenders(label: string, lines: string[]): string[] {
  // 違反を溜める入れ物
  const offenders: string[] = [];
  // 1 行ずつ見る
  lines.forEach((line, index) => {
    // 行内の注記を位置ごとに拾う (走査パターンを使い回すため lastIndex を戻す)
    SIZE_MARKER_ANYWHERE_PATTERN.lastIndex = 0;
    // 1 件ずつ取り出す
    let match: RegExpExecArray | null;
    while ((match = SIZE_MARKER_ANYWHERE_PATTERN.exec(line)) !== null) {
      // 注記の直前までがサイズ表記で終わっていれば正常なので次へ
      if (SIZE_TOKEN_AT_END_PATTERN.test(line.slice(0, match.index))) continue;
      // 終わっていなければ、その注記は何も検査していないので違反にする
      offenders.push(
        `${label}:${index + 1} の注記 '${match[0]}' の直前がサイズ表記になっていません ` +
          '(桁区切りや単位の書き方が走査から外れている可能性がある)',
      );
    }
  });
  // 失敗時のメッセージを安定させるため並べ替えて返す
  return offenders.sort();
}

/**
 * 散文に混じった nginx 形式のサイズ表記を違反として返す。
 *
 * この書式は単位表に無いので**表記としても注記の対象としても拾えない** = 検査の外に落ちる。
 * 書式そのものを禁じることで、「検査できない数値が散文に増える」経路を塞ぐ。
 * 値の正本はフェンス内の設定例なので、散文では数値を出さずそちらを参照させる。
 */
function nginxStyleOffenders(label: string, lines: string[]): string[] {
  // 違反を溜める入れ物
  const offenders: string[] = [];
  // 1 行ずつ見る
  lines.forEach((line, index) => {
    // 行内の該当表記を順に拾う (走査パターンを使い回すため lastIndex を戻す)
    NGINX_STYLE_SIZE_PATTERN.lastIndex = 0;
    // 1 件ずつ取り出す
    let match: RegExpExecArray | null;
    while ((match = NGINX_STYLE_SIZE_PATTERN.exec(line)) !== null) {
      // 検査できない書式なので違反として記録する (直し方も添える)
      offenders.push(
        `${label}:${index + 1} の '${match[0]}' は nginx 形式のサイズ表記です ` +
          '(散文では使わない。値の正本はフェンス内の設定例なので、そちらを参照させること)',
      );
    }
  });
  // 失敗時のメッセージを安定させるため並べ替えて返す
  return offenders.sort();
}

/**
 * 散文の行配列に対する違反を返す (空なら、数値がすべて定数と一致している)。
 *
 * `label` は違反メッセージに出す名前 (ドキュメントの相対パス)。**ファイルを読まない純粋関数**に
 * してあるので、合成した入力で本体そのものを検算できる (判定ロジックの写しをテスト側に
 * 持たない)。
 *
 * 違反の種類は、いずれも**検査が緩む方向へ倒れない**ようにするためのもの:
 *   - 注記が無い … 出典を書かずに数値を足した (その数値が検査から漏れる)。
 *   - 定数が無い … 注記が `SIZE_SOURCES` に無い名前を指している (改名に追随していない)。
 *   - 空の定数名 … `A,,B` や末尾のカンマなどの書き間違い。
 *   - 値の不一致 … 文章の数値が定数の現在値と違う (本テストの主眼)。
 *   - 宙浮きの注記 … 直前の数値を表記として拾えていない (`orphanMarkerOffenders`)。
 */
function driftOffendersIn(label: string, lines: string[]): string[] {
  // まず宙に浮いた注記を拾う (表記として認識できていない数値をここで捕まえる)
  const offenders: string[] = orphanMarkerOffenders(label, lines);
  // 続いて、検査できない書式 (nginx 形式) が散文に混じっていないかを見る
  offenders.push(...nginxStyleOffenders(label, lines));
  // 拾った表記を 1 件ずつ検査する
  for (const mention of collectSizeMentions(lines)) {
    // 違反メッセージの先頭に付ける位置情報 (どこを直せばよいか分かるように)
    const where = `${label}:${mention.line} の ${mention.token}`;
    // 注記が無ければ、その数値は検査できないので違反にする
    if (mention.marker === undefined) {
      offenders.push(`${where}: 出典の注記 <!--size:定数名--> がありません`);
      continue;
    }
    // 上流が持つ値だと宣言されているなら、値の検算はしない (注記の存在だけを要求する)
    if (mention.marker === UPSTREAM_MARKER) continue;
    // カンマ区切りの定数名を 1 つずつ検査する
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

/**
 * ドキュメント 1 つぶんの違反を返す (実ファイルを読んで `driftOffendersIn` へ渡すだけ)。
 */
function driftOffenders(relativePath: string): string[] {
  // フェンスを除いた散文を読み、判定本体へ渡す
  return driftOffendersIn(relativePath, readProseLines(relativePath));
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
      const mentions = collectSizeMentions(readProseLines(relativePath));
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

  it('コードフェンスの中身は対象外になる', () => {
    // nginx 設定例の値は `tests/entry-body-limit.test.ts` の担当で、
    // あちらは余裕の取り方を意図的に固定しない。ここで拾ってしまうとその判断と衝突するため、
    // フェンス除去が効いていることを固定する。
    // **目印はフェンス内にしか無い文字列を選ぶ。** 「経路の上限」や `client_max_body_size` は
    // 散文にも出てくるので、それを目印にすると除去が効いていなくても消えたように見えてしまう
    // (実際に一度そうなった。目印の選び間違いは検査を無意味にする方向の失敗)
    const lines = readProseLines(join('docs', 'security.md'));
    // フェンス内の nginx コメントが消えていること。**これ自体がサイズ表記を含む**ので、
    // 除去が効いていなければ「注記の無い表記」として上の検査が落ちる関係にある
    expect(lines.some((line) => line.includes('経路の上限 51MB + 1MB'))).toBe(false);
    // 転送設定の指令もフェンス内にしか無いので、併せて消えていることを見る
    expect(lines.some((line) => line.includes('include proxy_params'))).toBe(false);
    // 一方でフェンス外の散文は残っていること (除去が行き過ぎていないことの確認)
    expect(lines.some((line) => line.includes('入口の枠を経路の最大値に合わせている理由'))).toBe(
      true,
    );
  });

  // ここから下は**判定の本体 (`driftOffendersIn`) を合成入力で直接動かす**検算。
  // 判定ロジックの写しをテスト側に置くと、本体の分岐を削っても写しの方は通るため、
  // 番人に見えて何も守らないテストになる (実際にその形で書いてしまい、本体から
  // 「注記が無ければ違反」の分岐を消しても緑のままであることを確認した)
  describe('判定の本体が違反を拾う', () => {
    it('注記の無いサイズ表記を違反として報告する', () => {
      // 注記を書かずに数値だけを足した状態
      const offenders = driftOffendersIn('sample.md', ['メール取り込み（25MB）を受け付ける']);
      // 1 件だけ、注記が無いことを指す違反が出ること
      expect(offenders).toEqual([
        'sample.md:1 の 25MB: 出典の注記 <!--size:定数名--> がありません',
      ]);
    });

    it('定数の現在値と違う数値を違反として報告する', () => {
      // 実際の定数 (256KB) とは違う値を書いた状態
      const offenders = driftOffendersIn('sample.md', [
        'LINE 取り込み 512KB<!--size:LINE_WEBHOOK_MAX_BODY_BYTES-->',
      ]);
      // 正しい表記を添えた違反が 1 件出ること
      expect(offenders).toHaveLength(1);
      expect(offenders[0]).toContain('LINE_WEBHOOK_MAX_BODY_BYTES は 256KB');
    });

    it('存在しない定数名を指す注記を違反として報告する', () => {
      // 定数を改名したのに注記が古い名前を指している状態
      const offenders = driftOffendersIn('sample.md', ['256KB<!--size:LINE_WEBHOOK_LIMIT-->']);
      // 突き合わせる相手が無いことを指す違反が 1 件出ること
      expect(offenders).toHaveLength(1);
      expect(offenders[0]).toContain('LINE_WEBHOOK_LIMIT が SIZE_SOURCES にありません');
    });

    it('空の定数名を含む注記を違反として報告する', () => {
      // 末尾のカンマなどで空の名前が混ざった状態
      const offenders = driftOffendersIn('sample.md', [
        '256KB<!--size:LINE_WEBHOOK_MAX_BODY_BYTES,-->',
      ]);
      // 書き間違いを指す違反が 1 件出ること
      expect(offenders).toHaveLength(1);
      expect(offenders[0]).toContain('空の定数名があります');
    });

    it('複数の定数を指す注記は、そのうち 1 つでも一致しなければ違反にする', () => {
      // 1MB の 2 経路 (SSO ACS / Stripe) を指しつつ、値だけ間違っている状態
      const offenders = driftOffendersIn('sample.md', [
        '2MB<!--size:SSO_ACS_MAX_BODY_BYTES,STRIPE_WEBHOOK_MAX_BODY_BYTES-->',
      ]);
      // 両方について違反が出ること (片方だけ見て通す作りになっていないことの確認)
      expect(offenders).toHaveLength(2);
      expect(offenders.some((o) => o.includes('SSO_ACS_MAX_BODY_BYTES'))).toBe(true);
      expect(offenders.some((o) => o.includes('STRIPE_WEBHOOK_MAX_BODY_BYTES'))).toBe(true);
    });

    it('upstream 宣言は値を検算せず通す', () => {
      // 上流 (Next.js) が持つ値なので、定数と突き合わせない
      expect(driftOffendersIn('sample.md', ['既定 1MB<!--size:upstream-->'])).toEqual([]);
    });

    it('桁区切りのカンマを数値の一部として読む', () => {
      // `1,256KB` は約 5 倍の値なので、末尾の `256KB` だけを見て通してはいけない
      const offenders = driftOffendersIn('sample.md', [
        '1,256KB<!--size:LINE_WEBHOOK_MAX_BODY_BYTES-->',
      ]);
      // 値の不一致として落ちること (以前はここが素通りだった)
      expect(offenders).toHaveLength(1);
      expect(offenders[0]).toContain('文章を 256KB に直すこと');
    });

    it('バイト表記も検算の対象になる', () => {
      // formatBytes が案内する `N バイト` 形式が、そのまま検査対象になること。
      // 拾えないと「案内どおり直した瞬間に無検査」という穴になる
      const offenders = driftOffendersIn('sample.md', [
        '999999 バイト<!--size:MAGIC_LINK_CALLBACK_MAX_BODY_BYTES-->',
      ]);
      // 値の不一致として落ちること
      expect(offenders).toHaveLength(1);
      expect(offenders[0]).toContain('MAGIC_LINK_CALLBACK_MAX_BODY_BYTES は 64KB');
    });

    it('注記の無い nginx 形式の表記も違反として報告する', () => {
      // 注記が無いと宙浮き検査は働かないため、書式そのものを禁じて拾う。
      // これが無いと「散文に検査できない数値が増える」経路が残る (実際に §7 でそうなっていた)
      const offenders = driftOffendersIn('sample.md', ['足さなければ既定の 2m を継承する']);
      // 書式を指す違反が 1 件出ること
      expect(offenders).toHaveLength(1);
      expect(offenders[0]).toContain("'2m' は nginx 形式のサイズ表記です");
    });

    it('大文字の単位を nginx 形式と誤認しない', () => {
      // `10MB` の `MB` を小文字サフィックスとして拾ってしまうと、正しい表記が違反になる
      expect(driftOffendersIn('sample.md', ['10MB<!--size:MAX_ATTACHMENT_SIZE_BYTES-->'])).toEqual(
        [],
      );
    });

    it('直前がサイズ表記でない注記を宙浮きとして報告する', () => {
      // 数値を伴わない位置に注記だけを置いた状態。表記として拾うものが無いので、
      // 宙浮き検査が無ければ「違反ゼロで緑」になる
      const offenders = driftOffendersIn('sample.md', [
        '上限は定数で管理する<!--size:SSO_ACS_MAX_BODY_BYTES-->',
      ]);
      // 注記が何も検査していないことを指す違反が 1 件出ること
      expect(offenders).toHaveLength(1);
      expect(offenders[0]).toContain('直前がサイズ表記になっていません');
    });

    it('nginx 形式に注記を付けた場合は 2 種類の違反が出る', () => {
      // 走査から外れる書式に注記を付けた状態。書式の禁止と宙浮きの両方に該当し、
      // どちらの網でも捕まることを固定する (片方を消しても落ちる関係にしておく)
      const offenders = driftOffendersIn('sample.md', [
        '既定の 2m<!--size:SSO_ACS_MAX_BODY_BYTES-->',
      ]);
      // 2 件とも出ること
      expect(offenders).toHaveLength(2);
      expect(offenders.some((o) => o.includes('直前がサイズ表記になっていません'))).toBe(true);
      expect(offenders.some((o) => o.includes('nginx 形式のサイズ表記です'))).toBe(true);
    });

    it('フェンスの中に書かれた表記は違反にしない', () => {
      // フェンス内の nginx コメントには注記が無いが、除去されるので違反にならない
      const raw = ['文章の外側', '```nginx', '# 経路の上限 51MB + 1MB', '```', '文章の内側'].join(
        '\n',
      );
      // 除去した行配列を本体へ渡しても違反が出ないこと
      expect(driftOffendersIn('sample.md', stripFencedLines(raw))).toEqual([]);
    });
  });
});
