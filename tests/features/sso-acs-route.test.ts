// POST /api/auth/sso/[tenantId]/acs のレート制限テストと、ボディ取り出し段階の監査記録テスト。
// 監査で発見したギャップ (レート制限): 他の未認証受信エンドポイント (inbound-line/inbound-email) と
// 異なり、この ACS エンドポイントにはレート制限が無かった。ACS は未認証で到達でき、XML パース +
// 署名検証という CPU コストの高い処理をリクエストごとに行うため、二段構えのレート制限を追加した。
// /code-review ultra 指摘対応 (監査記録): SAMLResponse 欠落・ボディ破損での拒否 (sso-invalid) が
// AuthAuditLog に一切残らず、「成功・失敗とも全認証経路を記録する」不変条件から漏れていた。
// 記録されるようになったことをメモリアダプタ経由で検証する (sso-acs-replay.test.ts と同方式)。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetRateLimits } from '@/lib/rate-limit';
import { createMemoryContext, type Store } from '@/data/adapters/memory';
import type { Repos } from '@/data/ports/unit-of-work';
// 監査の失敗イベント書き込み予算をテスト間でリセットする (連打テストの消費を持ち越さない)。
// AUTH_AUDIT_UNKNOWN_EMAIL は本人を特定できない失敗経路で記録される代替メール (期待値の直書きを避ける)
import { AUTH_AUDIT_UNKNOWN_EMAIL, __resetAuthAuditThrottle } from '@/lib/auth-audit';
// ボディサイズ上限はルートと同じ定義を参照する (テストに閾値を直書きすると、
// 上限を変えたときにテストが境界を突かなくなったことに気付けない §6)
import { SSO_ACS_MAX_BODY_BYTES } from '@/lib/auth-body-limits';
// レート制限の上限もルートと同じ定義を参照する (テストに回数を直書きすると、上限を
// 変えたときにテストが境界を突かなくなったことに気付けない §6)。
// とくに issue #315 の修正後は「検証前 (未検証) の枠」と「検証後の枠」で上限が異なるため、
// どちらの枠を突いているテストなのかを定数名で示す意味もある
import {
  SSO_UNAUTHENTICATED_RATE_LIMIT,
  SSO_ACS_UNVERIFIED_TENANT_RATE_LIMIT,
  SSO_TENANT_RATE_LIMIT,
} from '@/lib/sso-rate-limit';
import { expectRateLimitTripsAfter } from './sso-rate-limit-assertions';

const TENANT_ID = 'tenant-1';

// 署名検証を通過させたいテストで使う SAMLResponse の接頭辞。
// 接頭辞の後ろをそのままアサーション ID として返すので、テスト側が
// 「毎回別のアサーション」と「同じアサーションの再送 (リプレイ)」を書き分けられる
const VALID_SAML_PREFIX = 'valid-assertion:';
// 検証成功時にアサーションから取り出せたことにするメール (下でこのメールのユーザーをシードする)
const VERIFIED_EMAIL = 'sso-user@example.com';

// 各テストで差し替える可変な依存 (Route import 前に値を入れる)
let store: Store;
let repos: Repos;

// @/data を差し替え (getter で beforeEach の上書きを反映。sso-acs-replay.test.ts と同方式)。
// 監査記録 (recordAuthAudit → repos.authAudit) がメモリアダプタに書き込むようにする
vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
}));

// SAML 検証をスパイに差し替える。サイズ上限のテストで「上限を超えた本文は署名検証まで
// 到達しない (= 手前で打ち切られている)」ことを表明するために必要。
// これが無いと、上限を撤去してもレスポンスは同じ sso-invalid のままなので
// テストが素通りしてしまい、回帰を検出できない
// issue #315 の回帰テスト用に、合図の値だけ検証成功にする (それ以外は従来どおり必ず失敗)。
// 「署名検証を通ったリクエストだけが検証後の枠を消費する」ことは、成功する経路を 1 本
// 用意しないと表明できない (すべて失敗させると枠が減らないのが当たり前になってしまう)
const validateSamlResponseSpy = vi.fn(async (_saml: unknown, samlResponse: string) => {
  // 接頭辞が付いていないものはすべて検証失敗として扱う。
  // 実際の node-saml も不正なアサーションでは例外を投げる
  if (!samlResponse.startsWith(VALID_SAML_PREFIX)) {
    throw new Error('テスト用: アサーション検証は常に失敗させる');
  }
  // 接頭辞の後ろを検証済みのアサーション ID として返す (リプレイ判定に使われる一意キー)
  return { email: VERIFIED_EMAIL, assertionId: samlResponse.slice(VALID_SAML_PREFIX.length) };
});
vi.mock('@/lib/saml', () => ({
  createSamlInstance: vi.fn(() => ({})),
  validateSamlResponse: validateSamlResponseSpy,
}));

// loadEnabledSsoContext を「常に SSO 利用可能」に固定する (テナント単位レート制限の検証に必要)
vi.mock('@/lib/sso-context', () => ({
  loadEnabledSsoContext: vi.fn(async () => ({
    ok: true,
    tenant: { id: TENANT_ID, name: 'テスト組織' },
    config: { idpEntityId: 'https://idp.example.com/entity' },
    baseUrl: 'http://localhost:3000',
  })),
}));

// リクエストを 1 件送るヘルパー (既定では SAMLResponse フィールドを意図的に省略する)。
// /code-review ultra 指摘対応: body/headers を上書き可能にし、空文字・破損ボディの
// テストケースでの Request 構築の重複を排除する (§6 DRY)
async function postAcs(
  tenantId: string,
  init: { body?: BodyInit; headers?: Record<string, string> } = {},
): Promise<Response> {
  const { POST } = await import('@/app/api/auth/sso/[tenantId]/acs/route');
  const req = new Request(`http://localhost:3000/api/auth/sso/${tenantId}/acs`, {
    method: 'POST',
    body: init.body ?? new URLSearchParams(), // 既定: SAMLResponse フィールドなし
    ...(init.headers ? { headers: init.headers } : {}),
  });
  return POST(req, { params: Promise.resolve({ tenantId }) });
}

// 「レート制限 (429) ではなく通常のエラー処理で sso-invalid へ戻された」ことを表明する共通ヘルパー。
// この 2 行は 4 箇所のテストで同じなので 1 箇所に集約する (§6 DRY)
function expectSsoInvalidRedirect(res: Response): void {
  // 303 See Other でブラウザを GET 遷移させる
  expect(res.status).toBe(303);
  // 遷移先はログイン画面で、理由コードは sso-invalid
  expect(res.headers.get('location')).toContain('error=sso-invalid');
}

// 記録された監査行が「検証不能なアサーション試行」として正しい形かを表明する共通ヘルパー。
// 拒否理由 (本文欠落・空文字・パース失敗・サイズ超過) が違っても監査行の形は同じなので、
// describe をまたいで 1 箇所から使う。とくに userId: null の表明を落とさないことが重要で、
// 検証を通っていないアサーションの主張からユーザーを紐付けてしまう回帰 (監査証跡への
// クロステナントな身元の混入) は、この 1 行だけが検出できる
function expectSingleRejectedAudit(): void {
  // メモリストアの監査行を取り出す
  const rows = [...store.authAuditLogs.values()];
  // ちょうど 1 件記録されている
  expect(rows).toHaveLength(1);
  // 種別は sso_assertion_rejected、メールは特定不能の代替値、テナントは URL から解決した値
  expect(rows[0]).toMatchObject({
    event: 'sso_assertion_rejected',
    email: AUTH_AUDIT_UNKNOWN_EMAIL,
    userId: null,
    tenantId: TENANT_ID,
  });
}

// 各テストの共通初期化: レート制限・監査予算・メモリストアを毎回まっさらにする
beforeEach(() => {
  __resetRateLimits();
  __resetAuthAuditThrottle();
  // SAML 検証の呼び出し履歴も毎回まっさらにする (「検証まで到達したか」の表明に使う)
  validateSamlResponseSpy.mockClear();
  const ctx = createMemoryContext();
  store = ctx.store;
  repos = ctx.repos;
  // 署名検証を通ったアサーションの本人に対応する既存ユーザーをシードする。
  // ACS は JIT 作成をしないので、これが無いと検証成功後すぐ sso-no-user で打ち切られ、
  // その先にある検証後のレート制限まで到達できない (= 枠の消費を検証できない)
  store.users.set('user-1', {
    id: 'user-1',
    email: VERIFIED_EMAIL,
    name: 'SSO 太郎',
    passwordHash: 'x', // SSO ログインでは使わないダミー値
    role: 'agent',
    tenantId: TENANT_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

describe('POST /api/auth/sso/[tenantId]/acs のレート制限', () => {
  // 署名検証を通る正規のアサーションを 1 件送るヘルパー (検証後の枠を消費させるのに使う)。
  // assertionId を呼び出しごとに変えるのが既定 (同じ ID を渡すとリプレイ扱いになる)
  const postVerifiedAcs = (assertionId: string) =>
    postAcs(TENANT_ID, {
      body: new URLSearchParams({ SAMLResponse: `${VALID_SAML_PREFIX}${assertionId}` }),
    });

  // 以降のテストは「未検証の枠のほうが検証後の枠より大きい」ことを前提にしている
  // (前提が崩れると、検証後の枠を突く前に未検証の枠で 429 になり、本丸のテストが
  // 「修正前と同じ症状」で落ちて原因を読み違えさせる)。前提そのものをここで表明しておく
  it('未検証の枠は検証後の枠より大きい (以降のテストが前提にしている大小関係)', () => {
    expect(SSO_ACS_UNVERIFIED_TENANT_RATE_LIMIT.limit).toBeGreaterThan(SSO_TENANT_RATE_LIMIT.limit);
  });

  // 固定キーの全体レート制限を超えると 429 を返す (テナントを毎回変えて全体枠だけを突く)
  it('未認証全体のレート制限を超えると429を返す', async () => {
    await expectRateLimitTripsAfter(
      (i) => postAcs(`tenant-${i}`),
      SSO_UNAUTHENTICATED_RATE_LIMIT.limit,
    );
  });

  // 同一テナントへの連打は、署名検証より手前の「未検証の枠」で 429 になる
  it('同一テナントへの連打は未検証リクエストのレート制限で429を返す', async () => {
    await expectRateLimitTripsAfter(
      () => postAcs(TENANT_ID),
      SSO_ACS_UNVERIFIED_TENANT_RATE_LIMIT.limit,
    );
  });

  // issue #315 の回帰テスト (本丸)。
  // 署名検証に落ちるリクエストは「検証後の枠」を 1 件も消費してはいけない。
  // 消費してしまうと、公開値である tenantId を知る第三者が出鱈目な SAMLResponse を
  // 上限ぶん投げるだけで、IdP からの正規アサーションまで 429 にできてしまう。
  // 修正前 (枠が 1 つで検証前に置かれていた) 状態ではこのテストが 429 で落ちる
  it('署名検証に落ちるリクエストは検証後のテナント枠を消費しない', async () => {
    // 検証後の枠の上限ぶんだけ、署名検証に落ちるリクエストを送る
    for (let i = 0; i < SSO_TENANT_RATE_LIMIT.limit; i++) {
      const res = await postAcs(TENANT_ID);
      // 未検証の枠のほうが上限が大きいので、この時点ではまだ 429 にならないはず
      expect(res.status).not.toBe(429);
    }
    // 直後に正規の (署名検証を通る) アサーションを送っても 429 にはならないはず
    const res = await postVerifiedAcs('assertion-after-noise');
    expect(res.status).not.toBe(429);
  });

  // issue #315 の回帰テスト (その 2)。
  // 「署名検証を通ること」だけを枠の入口にすると、どこかで捕捉した消費済みアサーション 1 通を
  // 再送し続けるだけで枠を使い切れてしまう (検証は毎回成功するため)。枠をリプレイ検査より
  // 後ろに置いているので、再送はここへ到達せず枠を 1 件も消費しないはず
  it('リプレイされたアサーションは検証後のテナント枠を消費しない', async () => {
    // 1 通目を正常に消費させる (この 1 件だけは枠を使う)
    const first = await postVerifiedAcs('assertion-replayed');
    expect(first.status).not.toBe(429);
    // まったく同じアサーションを枠の上限ぶん再送する (すべてリプレイとして拒否されるはず)
    for (let i = 0; i < SSO_TENANT_RATE_LIMIT.limit; i++) {
      const res = await postVerifiedAcs('assertion-replayed');
      // リプレイ拒否は 303 (sso-invalid) であって 429 ではない
      expectSsoInvalidRedirect(res);
    }
    // 再送が枠を消費していなければ、新しいアサーションはまだ通るはず
    const res = await postVerifiedAcs('assertion-fresh');
    expect(res.status).not.toBe(429);
  });

  // 検証後の枠そのものは生きていること (回帰テストのために枠を外していないことの確認)。
  // 署名検証を通ったリクエストだけを連打すると、その上限で 429 になる
  it('署名検証を通ったリクエストの連打は検証後のテナント枠で429を返す', async () => {
    await expectRateLimitTripsAfter(
      (i) => postVerifiedAcs(`assertion-burst-${i}`),
      SSO_TENANT_RATE_LIMIT.limit,
    );
  });

  // 「レート制限内なら 429 ではなく sso-invalid が返る」ケースは、下の監査記録テスト
  // (SAMLResponse 欠落) が同じリクエストで同じ表明を含んでいるため、ここには重複して置かない
});

describe('POST /api/auth/sso/[tenantId]/acs のボディ取り出し段階の監査記録', () => {
  // SAMLResponse フィールドそのものが無い POST も監査に残る
  // (レート制限内で 429 ではなく sso-invalid が返ることの確認も兼ねる)
  it('SAMLResponse欠落の拒否をsso_assertion_rejectedとして監査に記録する', async () => {
    const res = await postAcs(TENANT_ID);
    expectSsoInvalidRedirect(res);
    expectSingleRejectedAudit();
  });

  // SAMLResponse が空文字の POST も監査に残る
  it('SAMLResponse空文字の拒否をsso_assertion_rejectedとして監査に記録する', async () => {
    // フィールドはあるが空のフォームボディで送る
    const res = await postAcs(TENANT_ID, { body: new URLSearchParams({ SAMLResponse: '' }) });
    expectSsoInvalidRedirect(res);
    expectSingleRejectedAudit();
  });

  // formData() のパース自体が失敗するボディ (フォームでない Content-Type) も監査に残る
  it('ボディ破損(formDataパース失敗)の拒否をsso_assertion_rejectedとして監査に記録する', async () => {
    // formData() が throw する Content-Type と壊れた本文で送る
    const res = await postAcs(TENANT_ID, {
      body: '{"broken":',
      headers: { 'Content-Type': 'application/json' },
    });
    expectSsoInvalidRedirect(res);
    expectSingleRejectedAudit();
  });
});

describe('POST /api/auth/sso/[tenantId]/acs のリクエストサイズ上限', () => {
  // フォーム本文として解釈させるための Content-Type
  const FORM_CONTENT_TYPE = { 'Content-Type': 'application/x-www-form-urlencoded' };
  // ちょうど上限バイトになるフォーム本文を組み立てる (境界値の検証に使う)。
  // 'SAMLResponse=' の分を差し引いて全体が SSO_ACS_MAX_BODY_BYTES になるよう詰める
  const FIELD_PREFIX = 'SAMLResponse=';
  const bodyOfExactly = (totalBytes: number) =>
    FIELD_PREFIX + 'A'.repeat(totalBytes - FIELD_PREFIX.length);

  // ヘッダの申告だけで上限超過と分かる場合は、本文を読む前に打ち切る。
  // 本文自体は数バイトしかないので、実バイト数の検査だけならすり抜けてしまう。
  // それでも署名検証まで到達しない = ヘッダの事前検査が効いている、と言い切れる
  it('Content-Lengthヘッダが上限超過なら本文を読む前に拒否する', async () => {
    const res = await postAcs(TENANT_ID, {
      body: 'SAMLResponse=dummy', // 実サイズは上限内
      headers: {
        ...FORM_CONTENT_TYPE,
        'Content-Length': String(SSO_ACS_MAX_BODY_BYTES + 1), // 申告だけ超過
      },
    });
    expectSsoInvalidRedirect(res);
    // 上限で打ち切られたので、CPU コストの高い署名検証には進んでいない。
    // 上限を撤去するとこの本文は正常にパースされ検証まで進むため、ここで回帰を検出できる
    expect(validateSamlResponseSpy).not.toHaveBeenCalled();
  });

  // chunked 転送は Content-Length を省略できるため、ストリームの累計バイト数でも検査する。
  // Request は body から Content-Length を自動付与しないので、この経路がそのまま再現できる。
  // サイズ超過も #279 が閉じたギャップ (プローブの形式で監査に写る/写らないが変わる) を
  // 再び開けないよう他の拒否理由と同じ監査行を残すため、その表明もここに含める
  // (同一リクエスト・同一経路なので、監査だけ別テストに切り出すと重複になる §6 DRY)
  it('Content-Lengthが無くても実バイト数が上限超過なら拒否し監査に記録する', async () => {
    const res = await postAcs(TENANT_ID, {
      body: bodyOfExactly(SSO_ACS_MAX_BODY_BYTES + 1),
      headers: FORM_CONTENT_TYPE,
    });
    expectSsoInvalidRedirect(res);
    // 上限で打ち切られたので署名検証には進んでいない (上限撤去時に失敗する表明)
    expect(validateSamlResponseSpy).not.toHaveBeenCalled();
    // 監査行がちょうど 1 件、他の拒否経路とまったく同じ形で残っている
    expectSingleRejectedAudit();
  });

  // 境界値: ちょうど上限のボディは「超過」ではないので通す (> と >= の取り違え防止)。
  // 上限内まで進めば SAMLResponse は非空なので、この先の署名検証まで到達する
  it('ちょうど上限ぴったりのボディは拒否せず署名検証まで進む', async () => {
    const res = await postAcs(TENANT_ID, {
      body: bodyOfExactly(SSO_ACS_MAX_BODY_BYTES),
      headers: FORM_CONTENT_TYPE,
    });
    // 検証まで進んだうえで (テスト用スパイが必ず失敗させるので) sso-invalid になる
    expectSsoInvalidRedirect(res);
    // ちょうど上限は通すので署名検証に到達している (>= に取り違えるとここで失敗する)
    expect(validateSamlResponseSpy).toHaveBeenCalledTimes(1);
  });
});
