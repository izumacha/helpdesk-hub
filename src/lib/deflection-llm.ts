// AI FAQ 自己解決 (docs/smb-dx-pivot-plan.md §4.29) の LLM 照合クライアント。
//
// 前段抽出済みの FAQ 候補 (最大 DEFLECTION_CANDIDATE_LIMIT 件) と依頼者の入力を Anthropic Messages API に
// 渡し、「どの候補が依頼者の質問に答えているか」を構造化 (tool use) で返させる。
// - API キーはサーバー側の環境変数からのみ読む (§9 API キーをフロントエンドに露出させない)
// - モデル名・エンドポイントは定数/環境変数で管理し、ハードコードしない (§9)
// - 失敗しても例外を外に投げず ok:false を返す (§9 fail-safe: 提案が出ないだけで起票は続行できる)
// - 判定の採用可否 (候補外 ID の除外・確信度) はこのファイルでは判断せず、純粋関数
//   validateMatcherVerdict (src/domain/deflection.ts) に委ねる (§10 ロジックと I/O の分離)

// 前段抽出済み候補の型と、LLM の生の判定型
import type { DeflectionFaqSource, RawMatcherVerdict } from '@/domain/deflection';

// Anthropic Messages API のエンドポイント (固定ホストのみ。ユーザー由来の URL は一切使わない = SSRF 対象外)
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
// Anthropic API のバージョンヘッダ
const ANTHROPIC_API_VERSION = '2023-06-01';
// 環境変数 DEFLECTION_MODEL が未設定のときに使う既定モデル (Haiku 級: 日本語 FAQ 照合の精度とコストの均衡点)
export const DEFAULT_DEFLECTION_MODEL = 'claude-haiku-4-5';
// LLM 呼び出しのタイムアウト (ミリ秒)。起票フォームの操作を待たせすぎない上限
export const DEFLECTION_LLM_TIMEOUT_MS = 8_000;
// LLM の応答トークン上限 (判定 JSON は短いので小さく固定してコストと遅延を抑える)
const DEFLECTION_MAX_TOKENS = 300;
// LLM に判定を返させる tool の名前 (tool use で JSON 形式を強制するために使う)
const MATCH_TOOL_NAME = 'report_faq_matches';

// 環境変数の読み取り元の型。process.env をそのまま渡せる一方、テストでは最小限のオブジェクトを渡せる
// (NodeJS.ProcessEnv は本リポジトリの型定義で NODE_ENV が必須のため、直接は使わない)
export type DeflectionEnv = Readonly<Record<string, string | undefined>>;

// LLM 照合の結果。失敗理由は呼び出し側のログ用 (画面には出さない)
export type MatcherResult =
  | { ok: true; verdicts: RawMatcherVerdict[] } // 判定を取得できた (未検証。候補外 ID を含みうる)
  | { ok: false; reason: string }; // 呼び出しに失敗した (タイムアウト・HTTP エラー・応答不正)

// LLM 照合クライアントの契約。テストではこの型のモックに差し替える (§11 外部 API はモックする)
export interface DeflectionMatcher {
  model: string; // 照合に使うモデル名 (計測記録 DeflectionEvent.model に保存する)
  // 依頼者の入力と候補を渡して判定を得る
  match(input: {
    query: string;
    candidates: readonly DeflectionFaqSource[];
  }): Promise<MatcherResult>;
}

// AI FAQ 自己解決が構成済み (API キーあり) かを返す。未設定なら機能全体を無効化する (fail-closed ではなく
// 「提案が出ない」方向の縮退。起票そのものは影響を受けない)
export function isDeflectionConfigured(env: DeflectionEnv = process.env): boolean {
  // API キーが空でなければ構成済みとみなす
  return typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY.trim().length > 0;
}

// 環境変数からモデル名を解決する (未設定・空なら既定モデル)
export function resolveDeflectionModel(env: DeflectionEnv = process.env): string {
  // 空白を除いた値が残っていればそれを使い、無ければ既定モデルにフォールバックする
  const configured = env.DEFLECTION_MODEL?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_DEFLECTION_MODEL;
}

// LLM へのシステムプロンプト。役割と「候補に無い FAQ を作らない」ことを明示する
const SYSTEM_PROMPT = [
  'あなたは社内ヘルプデスクの FAQ 照合器です。',
  '依頼者の問い合わせに対し、与えられた FAQ 候補の中から「その回答を読めば問い合わせが解決する」ものだけを選びます。',
  '候補に無い FAQ を作ったり、候補の内容を言い換えたりしてはいけません。',
  '確信が持てない候補は選ばず、該当が無ければ空の一覧を返してください。',
  '判定は必ず report_faq_matches ツールで返してください。',
].join('\n');

// 依頼者の入力と候補一覧から、LLM に渡すユーザーメッセージ本文を組み立てる
function buildUserMessage(query: string, candidates: readonly DeflectionFaqSource[]): string {
  // 候補を「ID / 質問 / 回答」の並びで列挙する (ID は検証で照合するので改変されない形で渡す)
  const candidateText = candidates
    .map((c, i) => `[候補${i + 1}] id=${c.id}\n質問: ${c.question}\n回答: ${c.answer}`)
    .join('\n\n');
  // 問い合わせ本文と候補一覧を連結して返す
  return `## 依頼者の問い合わせ\n${query}\n\n## FAQ 候補\n${candidateText}`;
}

// Anthropic の応答 JSON のうち、このクライアントが読む部分だけの型
interface AnthropicMessageResponse {
  content?: Array<{ type?: string; name?: string; input?: unknown }>; // コンテンツブロックの一覧
}

// tool use の入力 (LLM が返した判定) を RawMatcherVerdict[] に変換する。
// 形が崩れていても例外にせず「不正な判定」として空/部分的な配列で返す (検証は domain 側で行う)
function extractVerdicts(response: AnthropicMessageResponse): RawMatcherVerdict[] | null {
  // 判定ツールの呼び出しブロックを探す
  const block = response.content?.find((b) => b.type === 'tool_use' && b.name === MATCH_TOOL_NAME);
  // ツール呼び出しが無ければ応答不正
  if (!block || typeof block.input !== 'object' || block.input === null) return null;
  // input.matches を取り出す (配列でなければ応答不正)
  const matches = (block.input as { matches?: unknown }).matches;
  if (!Array.isArray(matches)) return null;
  // 各要素から faqId / confidence をそのまま (未検証で) 取り出す
  return matches.map<RawMatcherVerdict>((m) => ({
    faqId: typeof m === 'object' && m !== null ? (m as { faqId?: unknown }).faqId : undefined,
    confidence:
      typeof m === 'object' && m !== null ? (m as { confidence?: unknown }).confidence : undefined,
  }));
}

// Anthropic Messages API を使う照合クライアントを生成する。
// fetch は差し替え可能にしてある (テストで実 API を呼ばないため。§11)
export function createAnthropicMatcher(options: {
  apiKey: string; // API キー (呼び出し側が環境変数から渡す)
  model: string; // モデル名
  fetchImpl?: typeof fetch; // テスト用の fetch 差し替え (省略時はグローバル fetch)
  timeoutMs?: number; // タイムアウト (省略時は DEFLECTION_LLM_TIMEOUT_MS)
}): DeflectionMatcher {
  // 差し替え可能な依存を解決する
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFLECTION_LLM_TIMEOUT_MS;
  return {
    model: options.model,
    async match({ query, candidates }) {
      // 候補が無ければ LLM を呼ばずに空判定を返す (無駄な呼び出しを避ける)
      if (candidates.length === 0) return { ok: true, verdicts: [] };
      // リクエスト本体 (tool use で判定 JSON の形を強制する)
      const body = {
        model: options.model,
        max_tokens: DEFLECTION_MAX_TOKENS,
        system: SYSTEM_PROMPT,
        // 判定を返すための tool 定義 (入力スキーマで faqId / confidence の形を指示する)
        tools: [
          {
            name: MATCH_TOOL_NAME,
            description: '依頼者の問い合わせに答えている FAQ 候補を確信度付きで報告する',
            input_schema: {
              type: 'object',
              properties: {
                matches: {
                  type: 'array',
                  description: '該当する候補の一覧 (該当なしなら空配列)',
                  items: {
                    type: 'object',
                    properties: {
                      faqId: { type: 'string', description: '候補の id をそのまま転記する' },
                      confidence: {
                        type: 'number',
                        description: 'その回答で解決する確信度 (0〜1)',
                      },
                    },
                    required: ['faqId', 'confidence'],
                  },
                },
              },
              required: ['matches'],
            },
          },
        ],
        // 必ずこの tool を呼ばせる (自由文で返されると解析できないため)
        tool_choice: { type: 'tool', name: MATCH_TOOL_NAME },
        messages: [{ role: 'user', content: buildUserMessage(query, candidates) }],
      };
      // 応答を受け取る変数
      let res: Response;
      try {
        // タイムアウト付きで API を呼ぶ (待たせすぎない。§9 タイムアウトを設ける)
        res = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': options.apiKey, // API キーはヘッダでのみ渡す (URL やログに出さない)
            'anthropic-version': ANTHROPIC_API_VERSION,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // ネットワーク断・タイムアウトは失敗として返す (キーや本文はログに含めない)
        return {
          ok: false,
          reason: `request failed: ${err instanceof Error ? err.name : 'unknown'}`,
        };
      }
      // HTTP エラーはステータスだけを理由にして返す (応答本文にはキー情報が含まれうるので出さない)
      if (!res.ok) return { ok: false, reason: `http ${res.status}` };
      // 応答 JSON を解析する (壊れていれば失敗)
      let json: AnthropicMessageResponse;
      try {
        json = (await res.json()) as AnthropicMessageResponse;
      } catch {
        return { ok: false, reason: 'invalid json' };
      }
      // tool use の判定を取り出す (形が崩れていれば失敗)
      const verdicts = extractVerdicts(json);
      if (verdicts === null) return { ok: false, reason: 'no tool_use block' };
      // 未検証の判定を返す (候補外 ID の除外は domain 側の validateMatcherVerdict が行う)
      return { ok: true, verdicts };
    },
  };
}

// 環境変数から既定の照合クライアントを組み立てる。未構成 (API キー無し) なら null
export function getDeflectionMatcher(
  env: DeflectionEnv = process.env,
): DeflectionMatcher | null {
  // API キーが無ければ機能を無効化する
  if (!isDeflectionConfigured(env)) return null;
  // API キーとモデル名で Anthropic クライアントを作って返す
  return createAnthropicMatcher({
    apiKey: env.ANTHROPIC_API_KEY as string,
    model: resolveDeflectionModel(env),
  });
}
