// AI FAQ 自己解決 (§4.29) の純粋ロジック (src/domain/deflection.ts) のユニットテスト。
// 前段抽出 (文字 bigram の Dice 係数) と LLM 判定の検証 (候補外 ID = 幻覚の除外) を、
// DB / LLM を持ち込まずに検証する (§11 純粋ロジックはユニットテスト)

// Vitest のテスト DSL
import { describe, expect, it } from 'vitest';
// テスト対象の純粋関数と定数
import {
  DEFLECTION_CANDIDATE_LIMIT,
  DEFLECTION_MAX_SUGGESTIONS,
  DEFLECTION_MIN_CONFIDENCE,
  rankFaqCandidates,
  validateMatcherVerdict,
  type DeflectionFaqSource,
} from '../src/domain/deflection';

// テスト用の公開 FAQ セット (社内ヘルプデスクらしい日本語)
const FAQS: DeflectionFaqSource[] = [
  {
    id: 'faq-vpn',
    question: 'VPN に接続できません',
    answer: 'VPN クライアントを再起動し、社内アカウントで再ログインしてください。',
  },
  {
    id: 'faq-printer',
    question: 'プリンターで印刷できない',
    answer: '複合機の電源を入れ直し、ドライバーを最新版に更新してください。',
  },
  {
    id: 'faq-expense',
    question: '経費精算の締め切りはいつですか',
    answer: '毎月 25 日 17 時までに申請してください。',
  },
];

describe('rankFaqCandidates: 前段抽出 (文字 bigram)', () => {
  // 字面が近い FAQ が最上位に来ること
  it('入力と字面が近い FAQ を最上位に返す', () => {
    // VPN 関連の問い合わせ
    const ranked = rankFaqCandidates('VPN接続\n在宅勤務中に VPN につながらなくなりました', FAQS);
    // 最上位は VPN の FAQ
    expect(ranked[0]?.id).toBe('faq-vpn');
    // スコアは 0〜1 の範囲
    expect(ranked[0]?.score).toBeGreaterThan(0);
    expect(ranked[0]?.score).toBeLessThanOrEqual(1);
  });

  // 全角/半角の違いを NFKC 正規化で吸収すること
  it('全角英数と半角英数を同一視する', () => {
    // 全角の「ＶＰＮ」で問い合わせる
    const ranked = rankFaqCandidates('ＶＰＮ につながりません', FAQS);
    // それでも VPN の FAQ が最上位になる
    expect(ranked[0]?.id).toBe('faq-vpn');
  });

  // 字面がまったく重ならない FAQ は最低スコア未満として除外されること
  it('まったく関係のない入力では候補を返さない', () => {
    // 英語だけの無関係な入力 (日本語 FAQ と bigram が重ならない)
    const ranked = rankFaqCandidates('hello world foo bar', FAQS);
    // 候補ゼロ
    expect(ranked).toEqual([]);
  });

  // 境界値: 1 文字以下の入力では bigram を作れない
  it('1 文字以下の入力では空配列を返す', () => {
    expect(rankFaqCandidates('あ', FAQS)).toEqual([]);
    expect(rankFaqCandidates('', FAQS)).toEqual([]);
  });

  // 上限件数 (既定 8 件) を超えて返さないこと
  it('limit を超える件数を返さない', () => {
    // 同じ FAQ を 20 件複製して母集団を作る (すべて同スコアで候補に残る)
    const many = Array.from({ length: 20 }, (_, i) => ({ ...FAQS[0], id: `faq-${i}` }));
    // 既定上限で切り詰められる
    expect(rankFaqCandidates('VPN に接続できません', many)).toHaveLength(
      DEFLECTION_CANDIDATE_LIMIT,
    );
    // 明示した limit でも切り詰められる
    expect(rankFaqCandidates('VPN に接続できません', many, 2)).toHaveLength(2);
    // limit 0 / 負数は空 (範囲外はクランプ)
    expect(rankFaqCandidates('VPN に接続できません', many, 0)).toEqual([]);
    expect(rankFaqCandidates('VPN に接続できません', many, -1)).toEqual([]);
  });

  // 純粋関数: 入力配列を破壊しないこと
  it('入力の FAQ 配列を変更しない', () => {
    // 呼び出し前のスナップショット
    const before = JSON.stringify(FAQS);
    rankFaqCandidates('VPN に接続できません', FAQS);
    // 呼び出し後も同じ
    expect(JSON.stringify(FAQS)).toBe(before);
  });
});

describe('validateMatcherVerdict: LLM 判定の検証 (引用の真正性)', () => {
  // 前段抽出で LLM に渡した候補 ID の集合
  const candidateIds = new Set(['faq-vpn', 'faq-printer']);

  // 候補外の ID (幻覚) を捨てること
  it('候補集合に無い faqId は幻覚として除外する', () => {
    const result = validateMatcherVerdict(
      [
        { faqId: 'faq-vpn', confidence: 0.9 }, // 候補内
        { faqId: 'faq-hallucinated', confidence: 0.99 }, // 候補外 (捏造)
      ],
      candidateIds,
    );
    // 候補内の 1 件だけが残る
    expect(result).toEqual([{ faqId: 'faq-vpn', confidence: 0.9 }]);
  });

  // 最低確信度未満は提示しないこと
  it('最低確信度未満の判定は除外する', () => {
    const result = validateMatcherVerdict(
      [{ faqId: 'faq-vpn', confidence: DEFLECTION_MIN_CONFIDENCE - 0.01 }],
      candidateIds,
    );
    expect(result).toEqual([]);
  });

  // 型が崩れた出力 (文字列の confidence / 数値の faqId / NaN) を捨てること
  it('faqId が文字列でない・confidence が有限数値でない判定は除外する', () => {
    const result = validateMatcherVerdict(
      [
        { faqId: 123, confidence: 0.9 }, // faqId が数値
        { faqId: 'faq-vpn', confidence: '0.9' }, // confidence が文字列
        { faqId: 'faq-vpn', confidence: Number.NaN }, // NaN
        { faqId: 'faq-printer', confidence: undefined }, // 欠落
      ],
      candidateIds,
    );
    expect(result).toEqual([]);
  });

  // 範囲外の確信度はクランプすること (1 を超える値は 1 に)
  it('1 を超える確信度は 1 にクランプする', () => {
    const result = validateMatcherVerdict([{ faqId: 'faq-vpn', confidence: 5 }], candidateIds);
    expect(result).toEqual([{ faqId: 'faq-vpn', confidence: 1 }]);
  });

  // 重複する faqId は 1 件にまとめ、確信度の高い順に並べること
  it('重複を除き、確信度の高い順に並べる', () => {
    const result = validateMatcherVerdict(
      [
        { faqId: 'faq-printer', confidence: 0.7 },
        { faqId: 'faq-vpn', confidence: 0.95 },
        { faqId: 'faq-printer', confidence: 0.99 }, // 重複 (後から来た方は捨てる)
      ],
      candidateIds,
    );
    expect(result.map((m) => m.faqId)).toEqual(['faq-vpn', 'faq-printer']);
    expect(result[1]?.confidence).toBe(0.7);
  });

  // 提示件数の上限を超えないこと
  it('maxSuggestions を超える件数を返さない', () => {
    // 候補を上限より多く用意する
    const ids = Array.from({ length: DEFLECTION_MAX_SUGGESTIONS + 3 }, (_, i) => `faq-${i}`);
    const verdicts = ids.map((faqId) => ({ faqId, confidence: 0.9 }));
    // 既定上限で切り詰められる
    expect(validateMatcherVerdict(verdicts, new Set(ids))).toHaveLength(DEFLECTION_MAX_SUGGESTIONS);
    // maxSuggestions 0 は空
    expect(validateMatcherVerdict(verdicts, new Set(ids), 0)).toEqual([]);
  });
});
