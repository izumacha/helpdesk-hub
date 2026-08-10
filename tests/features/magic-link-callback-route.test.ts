// POST /api/auth/magic-link/callback のリクエストサイズ上限テスト。
// /code-review ultra 指摘対応: SSO ACS には上限つきのボディ読み取りを入れたのに、同じ認証フロー上の
// 隣のルート (SSO の確認ページはここへ POST する) は request.formData() を素通しで呼んでおり、
// 未認証で到達できるうえサイズ上限が一切無かった。上限が効いていること (= 上限超過の本文が
// トークン消費まで進まないこと) を、signIn をスパイに差し替えて表明する。

import { beforeEach, describe, expect, it, vi } from 'vitest';
// レート制限はプロセス内カウンタなので、テスト間で持ち越さないよう毎回リセットする
import { __resetRateLimits } from '@/lib/rate-limit';
// ボディサイズ上限はルートと同じ定義を参照する (テストに閾値を直書きすると、
// 上限を変えたときにテストが境界を突かなくなったことに気付けない §6)
import { MAGIC_LINK_CALLBACK_MAX_BODY_BYTES } from '@/lib/magic-link';

// signIn をスパイに差し替える。「上限超過の本文はトークン消費 (DB 参照) まで到達しない」ことを
// 表明するために必要で、これが無いと上限を撤去してもリダイレクト先は同じ magic-link-invalid の
// ままなので、レスポンスだけを見るテストは素通りしてしまう
const signInSpy = vi.fn(async () => {
  // 認証は必ず失敗させる (このファイルは正常系ログインを扱わない)
  throw new Error('テスト用: signIn は常に失敗させる');
});
vi.mock('@/lib/auth', () => ({
  signIn: signInSpy,
}));

// 同一オリジン判定を常に true に固定する (CSRF 検証はこのファイルの関心事ではない)
vi.mock('@/lib/csrf', () => ({
  isSameOriginRequest: vi.fn(() => true),
}));

// next-auth 本体を読み込ませない。ルートは CredentialsSignin (認証拒否を表す例外クラス) だけを
// 使うが、実体を読むと next-auth の初期化コードが next/server を拡張子なしで import して
// Vitest の解決に失敗する。判定は instanceof なのでクラスさえあれば足りる
vi.mock('next-auth', () => ({
  CredentialsSignin: class CredentialsSignin extends Error {},
}));

// ルートは mock 適用後に読み込む (トップレベル import だと mock 前に評価されてしまう)
const { POST } = await import('@/app/api/auth/magic-link/callback/route');

// フォーム本文として解釈させるための Content-Type
const FORM_CONTENT_TYPE = { 'Content-Type': 'application/x-www-form-urlencoded' };
// ちょうど指定バイト数になるフォーム本文を組み立てる (境界値の検証に使う)。
// 'token=' の分を差し引いて全体が指定バイト数になるよう詰める
const FIELD_PREFIX = 'token=';
const bodyOfExactly = (totalBytes: number) =>
  FIELD_PREFIX + 'A'.repeat(totalBytes - FIELD_PREFIX.length);

// リクエストを 1 件送るヘルパー。redirect() は NEXT_REDIRECT を throw するため、
// 例外を捕まえて遷移先を含む文字列として返す (呼び出し側はこれを表明に使う)
async function postCallback(init: RequestInit): Promise<string> {
  // 対象ルートへの POST リクエストを組み立てる
  const req = new Request('http://localhost:3000/api/auth/magic-link/callback', {
    method: 'POST',
    ...init,
  });
  try {
    // ハンドラを呼ぶ (正常系でも redirect が throw されるので戻り値は使わない)
    await POST(req);
    // ここに到達したら redirect が起きていない = 想定外
    return 'no-redirect';
  } catch (err) {
    // NEXT_REDIRECT のエラーは digest に遷移先が入っている
    return String((err as { digest?: string }).digest ?? err);
  }
}

// 各テストの共通初期化: レート制限とスパイの呼び出し履歴を毎回まっさらにする
beforeEach(() => {
  __resetRateLimits();
  signInSpy.mockClear();
});

describe('POST /api/auth/magic-link/callback のリクエストサイズ上限', () => {
  // ヘッダの申告だけで上限超過と分かる場合は、本文を読む前に打ち切る。
  // 本文自体は数バイトしかないので、実バイト数の検査だけならすり抜けてしまう
  it('Content-Lengthヘッダが上限超過なら本文を読む前に拒否する', async () => {
    const digest = await postCallback({
      body: 'token=dummy', // 実サイズは上限内
      headers: {
        ...FORM_CONTENT_TYPE,
        'Content-Length': String(MAGIC_LINK_CALLBACK_MAX_BODY_BYTES + 1), // 申告だけ超過
      },
    });
    // ログイン画面へ magic-link-invalid で戻される
    expect(digest).toContain('/login?error=magic-link-invalid');
    // 上限で打ち切られたので、トークン消費 (DB 参照) には進んでいない。
    // 上限を撤去するとこの本文は正常にパースされ signIn まで進むため、ここで回帰を検出できる
    expect(signInSpy).not.toHaveBeenCalled();
  });

  // chunked 転送は Content-Length を省略できるため、ストリームの累計バイト数でも検査する。
  // Request は body から Content-Length を自動付与しないので、この経路がそのまま再現できる
  it('Content-Lengthが無くても実バイト数が上限超過なら拒否する', async () => {
    const digest = await postCallback({
      body: bodyOfExactly(MAGIC_LINK_CALLBACK_MAX_BODY_BYTES + 1),
      headers: FORM_CONTENT_TYPE,
    });
    // ログイン画面へ magic-link-invalid で戻される
    expect(digest).toContain('/login?error=magic-link-invalid');
    // 上限で打ち切られたのでトークン消費には進んでいない (上限撤去時に失敗する表明)
    expect(signInSpy).not.toHaveBeenCalled();
  });

  // 境界値: ちょうど上限のボディは「超過」ではないので通す (> と >= の取り違え防止)。
  // 上限内まで進めば token は非空なので、この先のトークン消費まで到達する
  it('ちょうど上限ぴったりのボディは拒否せずトークン消費まで進む', async () => {
    await postCallback({
      body: bodyOfExactly(MAGIC_LINK_CALLBACK_MAX_BODY_BYTES),
      headers: FORM_CONTENT_TYPE,
    });
    // ちょうど上限は通すので signIn に到達している (>= に取り違えるとここで失敗する)
    expect(signInSpy).toHaveBeenCalledTimes(1);
  });

  // フォームとして解釈できない本文は、従来どおりトークン無しと同じ扱いにする
  // (ヘルパー導入で挙動が変わっていないことの確認)
  it('フォームとして解釈できない本文はmagic-link-invalidへ戻す', async () => {
    const digest = await postCallback({
      body: '{"broken":',
      headers: { 'Content-Type': 'application/json' },
    });
    // ログイン画面へ magic-link-invalid で戻される
    expect(digest).toContain('/login?error=magic-link-invalid');
    // パースできていないのでトークン消費には進んでいない
    expect(signInSpy).not.toHaveBeenCalled();
  });
});
