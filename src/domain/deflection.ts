// AI FAQ 自己解決 (AI デフレクション) の純粋ロジック (docs/smb-dx-pivot-plan.md §4.29 / §6.1 Pro)。
//
// Prisma / Next / LLM SDK に依存しない純粋関数だけを置く (§10 ロジックと UI の分離)。
// 2 段構えの設計:
//   1. 前段抽出 (rankFaqCandidates): 公開済み FAQ 全件から、依頼者の入力と字面が近い上位 N 件を
//      文字 bigram の Dice 係数で選ぶ。LLM に渡すトークン量とコストを一定に保ち、無関係な FAQ を
//      候補から外す (§8 リソース)。日本語は分かち書きが無いため単語分割ではなく文字 bigram で比較する。
//   2. LLM 照合結果の検証 (validateMatcherVerdict): LLM が返した FAQ ID が候補集合に含まれるものだけを
//      採用する (候補外の ID = 幻覚として捨てる)。引用の真正性をここで機械的に強制する (§9 入力は信用しない)。

// 公開済み FAQ のうち LLM に渡す候補の最大件数 (前段抽出の上限)。
// 8 件は「Haiku 級モデルの 1 回の照合で精度が落ちない範囲」として A/B テスト設計時に決めた値
export const DEFLECTION_CANDIDATE_LIMIT = 8;

// 前段抽出で候補に残す最低スコア (Dice 係数 0〜1)。これ未満は字面がほぼ重ならないので LLM に渡さない。
// 0 にすると常に上位 N 件が渡ってしまい、無関係な FAQ への誤マッチ (幻覚) の温床になる
export const DEFLECTION_MIN_PREFILTER_SCORE = 0.05;

// LLM の判定を「該当あり」として採用する最低確信度 (0〜1)。これ未満の一致は提示しない
export const DEFLECTION_MIN_CONFIDENCE = 0.6;

// 依頼者に提示する FAQ の最大件数 (LLM の判定を確信度順に並べて上位だけ出す)
export const DEFLECTION_MAX_SUGGESTIONS = 3;

// 前段抽出に入力する依頼者本文の最大文字数。これより長い入力は先頭だけを使う
// (bigram 集合が巨大になって比較コストが入力長に比例して膨らむのを防ぐ。§9 ReDoS と同じ発想の上限)
export const DEFLECTION_QUERY_MAX_CHARS = 2_000;

// 前段抽出・LLM 照合に渡す FAQ 1 件の最小型 (公開済み FAQ の質問/回答だけを扱う)
export interface DeflectionFaqSource {
  id: string; // FAQ ID
  question: string; // 質問文
  answer: string; // 回答文
}

// 前段抽出の結果 1 件 (FAQ + 類似度スコア)
export interface RankedFaqCandidate extends DeflectionFaqSource {
  score: number; // 依頼者入力との Dice 係数 (0〜1。高いほど字面が近い)
}

// 比較の前に文字列を正規化する。
// - NFKC で全角英数・半角カナを統一する (「ＶＰＮ」と「VPN」を同一視)
// - 小文字化
// - 空白・句読点・記号を除去し、文字だけの並びにする (bigram に記号が混ざるとノイズになる)
function normalizeForBigram(text: string): string {
  // Unicode 正規化 + 小文字化 + 空白/記号除去 (\p{L}=文字, \p{N}=数字 だけを残す)
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

// 正規化済み文字列から文字 bigram (隣り合う 2 文字の組) の集合を作る。
// 1 文字以下の入力は bigram を作れないので空集合を返す
function toBigramSet(normalized: string): Set<string> {
  // 結果の集合
  const set = new Set<string>();
  // 先頭から 1 文字ずつずらして 2 文字を切り出す
  for (let i = 0; i + 1 < normalized.length; i += 1) {
    // i 文字目と i+1 文字目の組を登録する
    set.add(normalized.slice(i, i + 2));
  }
  // 出来上がった集合を返す
  return set;
}

// 2 つの bigram 集合の Dice 係数 (2×共通数 ÷ 合計数) を計算する。どちらかが空なら 0
function diceCoefficient(a: Set<string>, b: Set<string>): number {
  // 片方でも空なら比較できないので 0
  if (a.size === 0 || b.size === 0) return 0;
  // 共通する bigram の数
  let common = 0;
  // 小さい方の集合を走査して共通数を数える (走査コストを抑える)
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const gram of small) {
    // 相手側にも含まれていれば共通としてカウントする
    if (large.has(gram)) common += 1;
  }
  // Dice 係数を返す
  return (2 * common) / (a.size + b.size);
}

// 依頼者の入力 (件名 + 内容) に字面が近い公開済み FAQ を上位 limit 件まで選ぶ (前段抽出)。
// 純粋関数: 同じ入力には常に同じ結果を返す (§10)。スコアが最低値未満のものは返さない
export function rankFaqCandidates(
  query: string, // 依頼者の入力 (件名と内容を連結したもの)
  faqs: readonly DeflectionFaqSource[], // 公開済み FAQ の一覧
  limit: number = DEFLECTION_CANDIDATE_LIMIT, // 返す最大件数
): RankedFaqCandidate[] {
  // 入力を上限文字数で切り詰めてから正規化し、bigram 集合にする
  const queryGrams = toBigramSet(normalizeForBigram(query.slice(0, DEFLECTION_QUERY_MAX_CHARS)));
  // 入力が短すぎて bigram を作れない場合は候補なし
  if (queryGrams.size === 0) return [];
  // 各 FAQ にスコアを付ける (質問文と回答文を連結して比較。回答側にしか無い語にも当たるようにする)
  const scored = faqs.map<RankedFaqCandidate>((faq) => ({
    ...faq,
    // FAQ 側も同じ正規化 + bigram 化をして Dice 係数を求める
    score: diceCoefficient(
      queryGrams,
      toBigramSet(normalizeForBigram(`${faq.question}${faq.answer}`)),
    ),
  }));
  // 最低スコア未満を除外し、スコアの高い順 (同点なら元の並び順を維持) に並べて上位 limit 件を返す
  return scored
    .filter((c) => c.score >= DEFLECTION_MIN_PREFILTER_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit));
}

// LLM 照合の生の判定 1 件 (LLM の出力を JSON として解析したもの。信用できない外部入力として扱う)
export interface RawMatcherVerdict {
  faqId: unknown; // LLM が「該当」と主張する FAQ ID (候補集合に含まれる保証はない)
  confidence: unknown; // LLM が申告する確信度 (0〜1 の数値である保証はない)
}

// 検証済みの照合結果 1 件 (候補集合に実在し、確信度も数値として妥当なもの)
export interface ValidatedMatch {
  faqId: string; // 候補集合に実在する FAQ ID
  confidence: number; // 0〜1 にクランプ済みの確信度
}

// LLM の判定を候補集合と突き合わせて検証し、採用できるものだけを確信度順に返す。
// - faqId が候補集合に無い → 幻覚 (存在しない FAQ の引用) として捨てる
// - confidence が数値でない / 最低確信度未満 → 捨てる
// - 同じ faqId が複数回返っても 1 件にまとめる (最初の 1 件を採用)
// - 返す件数は maxSuggestions までに絞る
export function validateMatcherVerdict(
  verdicts: readonly RawMatcherVerdict[], // LLM の判定一覧 (未検証)
  candidateIds: ReadonlySet<string>, // 前段抽出で LLM に渡した候補の ID 集合
  maxSuggestions: number = DEFLECTION_MAX_SUGGESTIONS, // 返す最大件数
): ValidatedMatch[] {
  // 採用済み faqId の重複排除用
  const seen = new Set<string>();
  // 検証を通った判定を集める配列
  const accepted: ValidatedMatch[] = [];
  // 判定を 1 件ずつ検証する
  for (const v of verdicts) {
    // faqId が文字列でなければ不正な出力として捨てる
    if (typeof v.faqId !== 'string') continue;
    // 候補集合に無い ID は幻覚 (引用の捏造) として捨てる
    if (!candidateIds.has(v.faqId)) continue;
    // 同じ FAQ を二重に提示しない
    if (seen.has(v.faqId)) continue;
    // confidence が有限の数値でなければ捨てる (NaN / 文字列 / 欠落)
    if (typeof v.confidence !== 'number' || !Number.isFinite(v.confidence)) continue;
    // 0〜1 の範囲にクランプする (範囲外はクランプ、非数値はデフォルト = 捨てる、の規約)
    const confidence = Math.min(1, Math.max(0, v.confidence));
    // 最低確信度未満は提示しない
    if (confidence < DEFLECTION_MIN_CONFIDENCE) continue;
    // 採用する
    seen.add(v.faqId);
    accepted.push({ faqId: v.faqId, confidence });
  }
  // 確信度の高い順に並べて上位だけを返す (安定ソートなので同点は LLM の返却順を維持)
  return accepted.sort((a, b) => b.confidence - a.confidence).slice(0, Math.max(0, maxSuggestions));
}
