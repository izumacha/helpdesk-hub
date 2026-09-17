// AI FAQ 自己解決 (§4.29) の LLM 照合クライアント (src/lib/deflection-llm.ts) のテスト。
// fetch を差し替えて実 API を呼ばずに、リクエストの形 (キーはヘッダのみ・tool use 強制) と
// 失敗時の縮退 (例外を投げず ok:false) を検証する (§11 外部 API はモックする)

// Vitest のテスト DSL
import { describe, expect, it, vi } from 'vitest';
// テスト対象
import {
  DEFAULT_DEFLECTION_MODEL,
  createAnthropicMatcher,
  getDeflectionMatcher,
  isDeflectionConfigured,
  resolveDeflectionModel,
} from '../src/lib/deflection-llm';

// テスト用の候補
const CANDIDATES = [
  { id: 'faq-vpn', question: 'VPN に接続できません', answer: '再起動してください' },
];

// 指定した応答を返す fetch モックを作る
function fakeFetch(status: number, body: unknown): typeof fetch {
  // 呼び出しごとに Response を組み立てる
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

describe('環境変数の解決', () => {
  // API キーの有無で構成済み判定が変わる
  it('ANTHROPIC_API_KEY が空/未設定なら未構成、値があれば構成済み', () => {
    expect(isDeflectionConfigured({})).toBe(false);
    expect(isDeflectionConfigured({ ANTHROPIC_API_KEY: '   ' })).toBe(false);
    expect(isDeflectionConfigured({ ANTHROPIC_API_KEY: 'sk-test' })).toBe(true);
  });

  // モデル名は環境変数優先、未設定なら既定
  it('DEFLECTION_MODEL 未設定なら既定モデルを使う', () => {
    expect(resolveDeflectionModel({})).toBe(DEFAULT_DEFLECTION_MODEL);
    expect(resolveDeflectionModel({ DEFLECTION_MODEL: ' my-model ' })).toBe('my-model');
  });

  // 未構成なら null (機能無効)
  it('getDeflectionMatcher は未構成なら null を返す', () => {
    expect(getDeflectionMatcher({})).toBeNull();
    expect(getDeflectionMatcher({ ANTHROPIC_API_KEY: 'sk-test' })?.model).toBe(
      DEFAULT_DEFLECTION_MODEL,
    );
  });
});

describe('createAnthropicMatcher', () => {
  // 正常系: tool use の判定を未検証のまま返す
  it('tool_use ブロックの matches を判定として返す', async () => {
    const fetchImpl = fakeFetch(200, {
      content: [
        { type: 'text', text: '判定します' },
        {
          type: 'tool_use',
          name: 'report_faq_matches',
          input: { matches: [{ faqId: 'faq-vpn', confidence: 0.9 }, { faqId: 'x' }] },
        },
      ],
    });
    const matcher = createAnthropicMatcher({ apiKey: 'sk-test', model: 'm', fetchImpl });
    const result = await matcher.match({ query: 'VPN', candidates: CANDIDATES });
    // 判定はそのまま (検証は domain 側)
    expect(result).toEqual({
      ok: true,
      verdicts: [
        { faqId: 'faq-vpn', confidence: 0.9 },
        { faqId: 'x', confidence: undefined },
      ],
    });
    // リクエスト: API キーはヘッダのみ、URL に含めない。tool_choice で判定ツールを強制する
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(url).not.toContain('sk-test');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-test');
    const sent = JSON.parse(init.body as string) as {
      model: string;
      tool_choice: { type: string; name: string };
      messages: Array<{ content: string }>;
    };
    expect(sent.model).toBe('m');
    expect(sent.tool_choice).toEqual({ type: 'tool', name: 'report_faq_matches' });
    // 候補の ID と本文がそのままプロンプトに含まれる (LLM が転記できる形)
    expect(sent.messages[0]?.content).toContain('id=faq-vpn');
    expect(sent.messages[0]?.content).toContain('VPN に接続できません');
  });

  // 候補ゼロなら fetch を呼ばない
  it('候補が無ければ API を呼ばずに空判定を返す', async () => {
    const fetchImpl = fakeFetch(200, {});
    const matcher = createAnthropicMatcher({ apiKey: 'sk-test', model: 'm', fetchImpl });
    expect(await matcher.match({ query: 'VPN', candidates: [] })).toEqual({
      ok: true,
      verdicts: [],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // HTTP エラーは ok:false (本文は理由に含めない)
  it('HTTP エラーはステータスだけを理由にして ok:false を返す', async () => {
    const fetchImpl = fakeFetch(429, { error: { message: 'secret detail' } });
    const matcher = createAnthropicMatcher({ apiKey: 'sk-test', model: 'm', fetchImpl });
    const result = await matcher.match({ query: 'VPN', candidates: CANDIDATES });
    expect(result).toEqual({ ok: false, reason: 'http 429' });
  });

  // tool_use が無い応答は ok:false
  it('tool_use ブロックが無い応答は ok:false を返す', async () => {
    const fetchImpl = fakeFetch(200, { content: [{ type: 'text', text: '該当なし' }] });
    const matcher = createAnthropicMatcher({ apiKey: 'sk-test', model: 'm', fetchImpl });
    expect(await matcher.match({ query: 'VPN', candidates: CANDIDATES })).toEqual({
      ok: false,
      reason: 'no tool_use block',
    });
  });

  // ネットワーク例外は投げずに ok:false (例外名だけを理由にする)
  it('fetch が例外を投げても ok:false に縮退する', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('timeout', 'TimeoutError');
    }) as unknown as typeof fetch;
    const matcher = createAnthropicMatcher({ apiKey: 'sk-test', model: 'm', fetchImpl });
    expect(await matcher.match({ query: 'VPN', candidates: CANDIDATES })).toEqual({
      ok: false,
      reason: 'request failed: TimeoutError',
    });
  });
});
